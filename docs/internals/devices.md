# Devices

The environment server owns simulators and emulators the way it owns
terminals: discovery, streaming, and agent access all run there, and every
client reaches them through the environment connection. This is what makes the
Device panel work over Tailscale and T3 Connect, including when an SSH host runs the devices.

## Two external tools, one seam

[expo-device-hub](../../apps/server/src/device/LocalDeviceHost.ts) streams and
[agent-device](../../apps/server/src/device/AgentDeviceShim.ts) drives. Each is
npm-installed at a pinned version into the T3 home after its matching Device
panel consent step. Manual setup installs and starts only expo-device-hub;
agent-device remains absent and stopped until agent access is granted. Both run
with the server's Node; `npx` would make the first `device_open` after a reboot
depend on the registry. The hub is a supervised child rather than an imported
middleware because serve-sim loads private CoreSimulator frameworks through a
native addon, and a crash there must not take the server down.

Everything platform-specific sits behind
[`DeviceHost`](../../apps/server/src/device/DeviceHost.ts). The service lists,
boots, and shuts down devices through the host's device operations, and the
proxy and the MCP tools only see a hub origin and an agent-device endpoint.
Hosts that run expo-device-hub share one hub-backed implementation of those
operations, so a host whose devices live elsewhere only replaces them.
SSH hosts forward both endpoints to server loopback. Every proxied request
also carries the host id; device ids alone are not unique across hosts.

## EAS Simulator hosts are billed sessions

An [EAS host](../../apps/server/src/device/EasDeviceHost.ts) has no machine:
each opened device is an EAS Simulator session that bills the Expo account
until it stops. Every session is created with the host's run and idle limits,
the host refuses to start past its session limit, and closing the host stops
its sessions. Sessions it starts are recorded under the state directory and
stopped by the next server if this one dies; sessions other tools started on
the same account are never touched.

Each session brings its own preview host (serve-sim, or serve-emu for Android)
and agent-device daemon, with their own tokens. The proxy asks the host to
route each request (`DeviceHostReady.upstream`) and adds the session token server-side, so
clients never hold it. Agent config files are written per device
(`DeviceOperations.agentEndpoint`), which is why `device_open` opens the
device before targeting it. Device settings and tools run `simctl` or `adb` on
the device's machine, which EAS does not expose, so they are unavailable there.

## Simlock hosts lease through the agent-device front

A [Simlock host](../../apps/server/src/device/SimlockDeviceHost.ts) (alpha) opens a
device by running T3's own agent-device CLI against the gateway's agent-device
front (`connect proxy`, then `open`), not with Simlock's lease HTTP API:
agent-device cannot adopt a lease it did not allocate. The lease is bound to
that one agent-device session and to the directory `open` ran in, so
`agentEndpoint` hands every thread the same session, a `stateDir` holding its
connection record, and no `--udid`/`--serial` (the gateway refuses selectors).
Installs work only from that directory; `device_open` names it.

Simlock serves a lease's screen and input to its holder in serve-sim's formats
on both platforms: AVCC envelopes at `/v1/leases/<id>/stream` and serve-sim's
input messages at `/v1/leases/<id>/input`, both with the agent token. Clients
therefore treat a Simlock Android lease like iOS (`serveSimOnly` in the stream
client), and `upstream` maps serve-sim's `stream.avcc` and `helper/ws` paths to
those routes. Simlock has no MJPEG, screenshot, or host command routes, so the
panel offers only input there.
Leases are renewed while tracked and released at the host's age limit; one a
crashed server left behind ends on its own one TTL later, so there is no ledger.

## The hub is never exposed

serve-sim has a shell-exec route whose token is readable from its own
unauthenticated `/api`, and serve-emu's action routes have no auth at all. The
hub binds loopback and the only way in is the
[proxy](../../apps/server/src/device/DeviceHubProxy.ts), which allowlists the
stream, config, and screenshot routes and authenticates every request as an
environment session. `<img>` and `WebSocket` cannot carry headers, so the proxy
authenticates like the `/ws` upgrade: cookie, or a short-lived `wsTicket` that
bearer and DPoP clients mint over authenticated HTTP. The ticket is stripped
before the request reaches the hub.

Stream responses carry `Cache-Control: no-transform`; the compression
middleware would otherwise buffer an MJPEG body that never ends. Browsers paint an
MJPEG part only once the next part begins and the hub writes one only when the
screen changes, so the proxy
[re-sends the last part](../../apps/server/src/device/mjpegStillFrame.ts) after a
short quiet period. In browser dev, the Vite proxy must forward WebSocket
upgrades for `/api`, not only `/ws`.

## Device settings never go through the hub

serve-sim's preview drives its Tools panel by sending shell commands over that
same exec channel. Proxying it, even allowlisted, would hand any environment
session arbitrary command execution on the host, so T3 does not. The
[`device.action`](../../apps/server/src/device/DeviceActions.ts) RPC runs the
underlying `simctl`, `adb`, and serve-sim helper binaries itself through
`DeviceHostReady.run`, one typed action per control, and returns the settings
it reads back. The proxy allowlist grows only with read routes (accessibility
tree, foreground app, event log) and refuses non-GET methods everywhere except
screenshot capture and stream tuning.

## Agents drive through the CLI

The `device_*` toolkit is deliberately four tools: list, open, screenshot, and
close. Driving happens through the `agent-device` CLI, which has the semantic
snapshot model agents need and stays current with its own releases. T3 prepends
a shim directory to the provider's PATH. The CLI installs on the environment
server even when that server cannot run simulators. Hosts start on demand.

That environment is fixed when the provider subprocess spawns, so
[`prepareMcpSession`](../../apps/server/src/orchestration-v2/ProviderSessionManager.ts)
starts agent-device only when device support and agent access have both been
enabled, the session has the `device` capability, and the machine can run at
least one platform. Starting it later from `device_open` would leave the
already-running agent without the CLI.

How to drive a device is returned from `device_open`, not kept in an
always-loaded prompt or skill: it costs nothing in threads that never open a
device and cannot drift from the pinned CLI version. `device_open` returns a
launcher bound to its agent-device session, so agents need no target flags.
The launcher leaves out the flags a command refuses (`cdp` talks to Metro, not
to the device), refuses the commands that would replace T3's connection, and
checks that connection first: agent-device reports a sandboxed shell and a
dropped tunnel alike as an unreachable daemon, so the launcher names which one it
is. Ending a session (`device_close`, the Device panel, a shutdown) also closes
its agent-device session, which quits the app that session opened and releases the CLI's claim on the device.

Agents choose between these tools and ssh before they open anything, so
sessions that hold `device` get a short block from
[`orchestrationInstructions.ts`](../../packages/provider-core/src/server/orchestrationInstructions.ts)
through their adapter's instruction channel. It points simulator and emulator UI
work on local and SSH hosts at the tools; `simctl`, `adb` and ssh stay
available for what the tools do not cover. Pi and Muse do not send it yet.
Claude's native subagents never see the session's system prompt, so a
`SubagentStart` hook passes them the block, where the runtime runs hooks and the
subagent's context is not isolated.

## The viewer decodes both vendored protocols

The hub vendors two streaming servers with different wire formats. iOS video is
an HTTP body of AVCC envelopes decoded with WebCodecs, with input on a separate
binary WebSocket; Android multiplexes SEMU-framed H.264 and JSON gestures over
one WebSocket. [`DeviceStreamView.tsx`](../../apps/web/src/components/device/DeviceStreamView.tsx)
speaks both so one panel covers both platforms.

WebCodecs is secure-context only, so the viewer probes `isConfigSupported` and falls back to
MJPEG on iOS when decoding is unavailable. Android's SEMU socket has no MJPEG;
there the panel reports that it cannot decode.

serve-sim can also be locked to WebRTC, as on EAS Simulator, and then refuses
AVCC with a 409 naming the transport. The viewer still asks for AVCC first, so
hubs that serve it pay nothing, and switches on that 409, or when its MJPEG
image fails in a browser that has `RTCPeerConnection`. Offers are not trickled:
serve-sim takes one offer with every candidate. The video element only feeds
the same canvas sink, so the panel and the mobile WebView keep one surface.
Android asks serve-emu's `/api` before opening its video socket and streams
WebRTC when it is advertised (EAS Simulator), keeping a separate `video=0`
socket for input so input can reconnect without restarting video.

## macOS VMs share the panel and the tools, not the hub

macOS VMs appear in the Device panel and answer to `device_list`, `device_open`,
`device_screenshot`, and `device_close`, but they stay out of `DeviceService` and
its hosts. A VM streams Cua's own web viewer through
[`VirtualMachineViewerProxy`](../../apps/server/src/vm/VirtualMachineViewerProxy.ts)
and is driven through Cua's guest MCP server, so nothing from the hub, the
stream protocols above, or agent-device applies. The device tools route a
`virtualMachine` target to
[`VirtualMachineService`](../../apps/server/src/vm/VirtualMachineService.ts), and
only guest input, guest commands, uploads, and VM creation and deletion keep
`vm_*` tools.

VMs need no device hub, so the panel lists them while the hub is off once VMs
are turned on. Agents still reach them only with **Agents can use devices**: the
`vm_*` tools check the same `device` capability as the device tools. A VM tab is
an ordinary device tab whose id is `device:@vm:<name>`; host ids cannot contain
`@`, so it never collides with a device's tab.

Guest commands go through `cua sandbox exec`, which holds one process open per
command and has no detached mode. A long build would pin a host process and a
tool call for its whole run, so `vm_exec` with `background` writes the command
to a file under `~/.t3-vm-jobs/<id>` in the guest, starts it there, and returns.
`vm_job` reads the pid, exit code, and log tail from that directory. The state
lives in the guest so it survives a server restart and a suspend, and the
server keeps no job table to lose.

Sessions are per thread and VM, but a suspend or delete ends all of them. The
service remembers why each session ended, so a thread that loses its VM to
another client learns why on its next call. `device_list` also reads Lume's own
store. Cua lists
only the VMs it created, while Apple's limit of two running macOS guests counts
every VM on the Mac, so the slot holders are visible only there. The same list
names them when a start fails at the limit.

A clone is `cua sandbox fork` from a suspended VM T3 manages. Cua copies the
disk with APFS clonefile and restores the saved memory, so the clone is ready in
seconds with a new machine identity. The source must be suspended because a
running source would be copied mid-write.

VM tabs stay mounted while hidden
([`VirtualMachineTabs`](../../apps/web/src/components/vm/VirtualMachineTabs.tsx)):
remounting reopens the VM and restarts Cua's stream, which takes seconds where a
device stream takes a frame. Moving an iframe in the DOM also reloads it, so the
tabs render in id order, not tab order. On web, T3 draws the VM's controls rail
and the bridge hides Cua's toolbar; fullscreen and file pickers inside the frame
need the frame's own user activation, so they cannot move to the rail.
