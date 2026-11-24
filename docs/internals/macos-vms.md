# macOS virtual machines

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

### macOS 27 guests

Cua's images run macOS Tahoe. A macOS 27 VM starts from a Lume VM that Cua did
not create, such as a clone of Native Tile's CI image, prepared once by hand the
way Cua's image is:

1. SIP is off (recoveryOS, then `csrutil disable`), so an agent can grant an app
   it built Accessibility or Screen Recording by writing TCC.db.
2. Cua's guest service is installed as in Cua's image:
   `/Applications/Cua Spacesd.app`, `/opt/cua/bin/start-spacesd.sh`, and the
   `com.trycua.spacesd` LaunchAgent.
3. `com.trycua.cua-env-driver` has Accessibility, Screen Recording, and PostEvent
   in the system TCC.db, and Cua's `ScreenCaptureApprovals.plist` keeps macOS
   from asking about the private window picker.
4. No token is baked in, and `~/.cua/spacesd` is empty, so each clone gets its
   own token and machine key.
5. Setup Assistant has been finished once, so a boot reaches the desktop.

`vm_create` with `from` naming such a VM runs `lume clone` and then writes the
files that make the clone a Cua sandbox, the same files Cua writes for its own:

- `virtual-machines/cua/<name>.json` under the state directory, Cua's sandbox
  record, with a new 256-bit guest token. Like Cua's own records it is 0600 in
  a 0700 folder.
- `~/.cua/vmm/lume/<name>/setup/env-token`, the same token. Cua shares this
  folder with the guest at every start, and `start-spacesd.sh` reads it there.
- `~/.cua/vmm/lume/<name>/ports.json`, `[3211]`. It tells Cua the guest
  publishes its service; without it Cua runs commands over SSH and refuses
  `--cwd` and `--timeout`.

The record is written last, and a failed write removes the clone and its folder.
These are Cua's private formats, checked against Cua 0.24.1, so a Cua update
that changes them breaks this path at `device_open` and nothing else.
`cua sandbox rm` deletes the clone, its folder, and its record.

Cua's own VMs sit behind its network gateway, which forwards guest ports to
127.0.0.1. A clone made this way stays on Lume's NAT, and Cua reaches its guest
service at the guest's 192.168.64.x address. macOS lets an app reach that
address only with Local Network permission, so the app that runs the T3 server
needs it. Without it, `device_open` waits for the desktop and fails.

VM tabs stay mounted while hidden
([`VirtualMachineTabs`](../../apps/web/src/components/vm/VirtualMachineTabs.tsx)):
remounting reopens the VM and restarts Cua's stream, which takes seconds where a
device stream takes a frame. Moving an iframe in the DOM also reloads it, so the
tabs render in id order, not tab order. On web, T3 draws the VM's controls rail
and the bridge hides Cua's toolbar; fullscreen and file pickers inside the frame
need the frame's own user activation, so they cannot move to the rail.
