# Devices

Stream and interact with live iOS Simulators, Android Emulators, physical Android devices, and [macOS virtual machines](#macos-virtual-machines) right beside a thread, and let agents inspect and drive them via `device_*` tools and the `agent-device` CLI.

## Open a device

Open the right panel in a project thread and choose **Device** (first-time setup starts the device hub, checks iOS/Android tools, and asks whether agents may control devices).

- Start a stopped device or attach to a running one; open additional devices via **+ → Device**.
- Click, drag, and type directly on the live screen; use the toolbar for Home, Back, Recents, rotate, power off, **3D view** (and fold/unfold on foldables), **Tools**, or **Float device over chat**.
- **Tools drawer**: Inspect the foreground app, toggle dark mode, text size, accessibility overlays, mock location, app permissions, iOS VoiceOver / test push notifications, and Android orientation / network toggles.
- Closing a tab stops streaming without powering off the device. Turn off **Settings → Devices → Simulators and emulators** to stop helper processes.

## Host prerequisites

Devices run on the environment's server machine (or an SSH/Simlock device host):

- **iOS Simulators**: macOS with Xcode.
- **Android Emulators**: Android SDK Platform-Tools, Android Emulator, Command-line Tools (latest), an AVD created in Android Studio, and `ffmpeg` with `libx264` on `PATH` (or `SERVE_EMU_FFMPEG`). Set `ANDROID_HOME` for custom SDK paths.
- **Physical Android devices**: SDK Platform-Tools only (no `ffmpeg`). Enable **USB debugging** (and **USB debugging (Security settings)** on Xiaomi devices), or pair wirelessly via `adb pair <addr>:<pairing-port>` then `adb connect <addr>:<port>`.

Restart the environment server after installing SDK tools or changing `PATH` / `SERVE_EMU_FFMPEG`.

## Agents and devices

Enable **Settings → Devices → Agents can use devices** so agents can drive devices through `agent-device` (restart existing agent sessions after enabling). First iOS tap builds a small test runner once per server (~2 minutes).

When an agent opens a device, it floats over chat by default (set **Settings → Browser → Open agent previews in** to **Right panel** to open it there instead). On mobile, tap the device button above the composer to watch and interact.

## macOS virtual machines

A macOS VM is a separate Mac for testing desktop apps while you keep using your
own. It appears in the Device panel beside simulators and emulators. The
environment server must run on an Apple silicon Mac with
[Lume](https://cua.ai/docs/lume/quickstart) and
[Cua](https://cua.ai/docs/cua-cli) 0.4 or later installed, including when you
connect from another computer or your phone.

Turn on **macOS virtual machines** during device setup, in **Settings →
Devices**, or with **Turn on** in the Device panel, then choose **Create VM**.
Setup does not need the device hub if you only want VMs.
VMs run macOS Tahoe with four CPUs and 8 GB of memory. Allow at least 60 GB free
for the first image download and guest disk; Apple allows two running macOS VMs
at a time. Host folders and your clipboard are not shared.

Choose **Open** or **Start** next to a VM to watch and control its desktop in a
device tab. Like a device, it can save a screenshot or **Float VM over chat**.
Switching tabs keeps a VM's desktop connected, so it shows at once when you
return. Closing the tab ends the thread's control and leaves the VM running.
**Suspend** releases its CPU and memory and closes its views in every thread;
opening it again resumes it. **Delete** removes the VM and its files. Turning
VMs off closes their views without deleting or stopping them. VMs you manage
with your own Cua commands are not listed.

When **Agents can use devices** is on, agents open VMs with `device_open`, which
floats the VM over the chat or opens a tab the same way as a device. They drive
the desktop with `vm_control` and run guest commands with `vm_exec`. A build or
test suite runs as a background job that the agent reads with `vm_job`, so it
has no time limit. `vm_upload` copies a file from the thread's workspace into
the guest and `vm_download` copies one back. Source editing and Git stay in your
workspace.

Opening a VM tells the agent which macOS it runs, its size, and whether Xcode is
installed. The Tahoe image has the Command Line Tools only, so install Xcode in
the guest before asking an agent to build an Xcode project or run XCTest there.
Suspending a VM from the Device panel ends every agent's session on it. The next
call from an agent that was using it explains why, and the agent has to open the
VM again. An agent cannot suspend a VM that another thread has open.

To give each task a clean machine, prepare one VM, install what your project
needs such as Xcode, and suspend it. An agent can then clone it with `vm_create`
and `from`. The clone starts in seconds with the base's apps and permission
grants, and the agent deletes it when done. Each running clone takes one of the
two macOS VM slots.

The source of a clone can also be a macOS VM in Lume that T3 did not create,
such as a macOS 27 base with Xcode. `device_list` shows these under the host
with `managed: false`. `vm_create` with `from` copies a stopped one with
`lume clone` and adds only the copy to T3, so the source is never started or
changed. The copy starts stopped, and `device_open` boots it. T3 Code reaches
the copy over Lume's local network, so allow the app that runs the environment
server in **System Settings → Privacy & Security → Local Network**. The guest
must run Cua's guest service the way Cua's own images do; see
[macOS 27 guests](../internals/macos-vms.md#macos-27-guests). To change such a
base, clone it, change the clone in T3, suspend it, and clone that from then on.

You can also run such a VM itself in T3. The Device panel lists macOS VMs in
Lume that Cua did not make under **Other Lume VMs**. Shut one down in Lume, then
choose **Open** to add it to T3 and start it. Everything that changes inside it
stays in that VM, so clone a base instead if you want to keep it unchanged. The
same Local Network permission and guest service apply. Its menu offers **Remove
from T3** instead of **Delete**: T3 suspends it if it is running and stops
listing it as its own, and the VM stays in Lume. Agents can open it once it is
in T3, but only you can add one.

In the mobile app, the thread's **Devices** menu lists what is open and starts
or opens any VM. The viewer can reconnect, close the thread's view, or suspend
the VM. Create, delete, add Lume VMs, and turn VMs on from web or desktop.

## Remote connections

Device video streams through the environment server (works over LAN, Tailscale, and T3 Connect). Live video requires HTTPS or `localhost`—plain HTTP remote origins fall back to still images on iOS and disable video on Android (except Expo Simulators).

## SSH device hosts

Use simulators/emulators on another macOS or Linux machine (e.g., a Mac build host from Linux/Windows):

1. Open **Settings → Devices → Add source → Machine over SSH** and enter an SSH alias or `user@host` (uses the environment server's SSH config/keys; no password prompts).
2. Run **Test connection** to verify SSH, Node.js 22.12+, npm, and SDK tools (Android on SSH hosts requires full SDK tools + `ffmpeg` for emulators).
3. First listing installs pinned device helpers on the SSH host.

> Note: Remote simulators cannot reach `localhost` dev servers (like Metro) on your main host without port forwarding or a reachable network address.

## Simlock hosts (alpha)

Connect to a [Simlock](https://incubator.callstack.com/simlock/) device pool (requires Simlock `main` at commit `6316e10`+ with `capabilities.stream.enabled` and `capabilities.input.enabled`):

1. Enable **Settings → Labs → Simlock device hosts (alpha)** and **Settings → Devices → Simulators and emulators**.
2. Choose **Add source → Simlock pool** with an agent token (`simlock --gateway token create --role agent`) over HTTPS or Tailscale (give each T3 server its own token; treat it like worker shell access).
3. Closing a device with **Return device to the pool** wipes and releases the lease. Toolbar tools/rotation/screenshots are unavailable in the UI (agents can still invoke them via `device_open`).

## Device tool updates

The T3 server manages device hub and `agent-device` versions automatically on itself and SSH hosts. Check versions in **Settings → Devices → Check versions**; update the remote T3 server to receive newer device tools.
