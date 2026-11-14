import {
  type DeviceError,
  type DeviceHostId,
  type DeviceHostSummary,
  type DeviceId,
  type DevicePlatform,
  type DeviceServiceState,
  type DeviceSummary,
  DeviceToolUnavailableError,
  LOCAL_DEVICE_HOST_ID,
  type ThreadId,
  VirtualMachineError,
  type VirtualMachineGuest,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as VirtualMachineService from "../../../vm/VirtualMachineService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit, DeviceToolkit } from "./tools.ts";

function agentDeviceTargetArgs(device: DeviceSummary): ReadonlyArray<string> {
  return device.platform === "ios"
    ? ["--platform", "ios", "--udid", device.id]
    : ["--platform", "android", "--serial", device.id];
}

const shellWord = (value: string) =>
  /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** `targetArgs` are the flags the command still needs; a bound launcher needs none. */
export function agentDeviceQuickStart(
  device: DeviceSummary,
  targetArgs = agentDeviceTargetArgs(device),
  command = "agent-device",
  host?:
    | { readonly kind: "eas" }
    | { readonly kind: "simlock"; readonly installDirectory?: string },
): string {
  const executable = shellWord(command);
  const target = targetArgs.map(shellWord).join(" ");
  const run = (args: string) => [executable, args, target].filter(Boolean).join(" ");
  const platformNotes =
    host?.kind === "simlock"
      ? [
          "This device is leased from a Simlock pool (alpha in T3 Code). The lease returns it to the pool, wiped, when it ends, so call device_close with shutdown: true when you are done. It starts with no apps installed.",
          host.installDirectory
            ? `agent-device accepts install for this lease only when run from ${host.installDirectory}.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : host?.kind === "eas"
        ? "This is an EAS Simulator session in the cloud. It bills the Expo account per minute until it stops, so call device_close with shutdown: true when you are done. It starts with no apps installed: install-from-source <url> installs a build from a URL (iOS needs a .tar.gz containing a .app), and install uploads one from this machine."
        : device.platform === "ios"
          ? "First use builds an XCTest runner and can take a couple of minutes; later commands are fast."
          : "The Android snapshot helper installs itself on first use.";
  return [
    `The user is watching ${device.name} (${device.version}) in the Device panel.`,
    target === ""
      ? `Drive it with ${executable}. It is bound to this device and session, so it needs no --platform, --udid, --serial, --config or --session flags. Use this exact path; login shells may reset PATH.`
      : `Drive it with ${executable}. Use this exact path; login shells may reset PATH. Always pass ${target}.`,
    // Screenshots and input need the session agent-device's open starts, and an iOS snapshot also
    // needs its app. device_open does not run open itself: on iOS that can start a minutes-long
    // XCTest runner build.
    "Every app launch, deep link, tap, text entry, alert, setting, screenshot and recording on this device goes through it. Run open <bundle-or-package-id> (apps lists them) before snapshots, CLI screenshots or input; it starts the session they need. Use device_screenshot just to look.",
    `  ${run("open <bundle-or-package-id> --relaunch")}  # restarts the app; Expo dev clients connect to their Metro, --metro-port <port> picks it`,
    `  ${run("open <bundle-or-package-id> <deep-link-url>")}`,
    `  ${run("snapshot -i")}  # accessibility tree with @eN refs`,
    `  ${run("press @e3 --settle")}`,
    `  ${run('fill @e5 "text" --settle')}`,
    `  ${run("alert accept")}`,
    `  ${run("settings appearance dark")}  # also text-size, permission grant <name>`,
    `  ${run("screenshot /tmp/shot.png")}  # ${device.platform === "ios" ? "iOS saves 1x points; add --pixel-density <n> (3 on most iPhones) for device resolution, " : ""}or call device_screenshot to look`,
    `  ${run("record start --scope device /tmp/run.mp4")}  # then record stop`,
    `  ${run("install <app> <path-to-.app-or-.apk>")}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help <command> for flags and ${executable} help workflow for guides.`,
    "Do not use simctl, idb, adb or ssh for those actions. They stay fine for builds, installs, code sync, Metro, port forwards, logs, test runners and what this command cannot do; come back to it for every UI action and screenshot so the user can watch.",
    "Each device_open returns its own command; opening another device does not retarget this one.",
    ...(target === ""
      ? [
          "The command is removed when the device closes or T3 Code restarts. If it is missing, call device_open again.",
        ]
      : []),
    platformNotes,
  ].join("\n");
}

const agentDeviceAccessDisabled = () =>
  new DeviceToolUnavailableError({
    reason:
      "Agent device access is turned off for this environment. Ask the user to turn on Agent device access in Settings > Integrations > Devices; it applies when the agent session next starts, such as in a new thread.",
  });

export const requireDeviceAccess = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("device").pipe(
    Effect.mapError(agentDeviceAccessDisabled),
  );
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(
    Effect.mapError(
      () =>
        new DeviceToolUnavailableError({
          reason:
            "Agent device access could not be checked. Try again after the environment reconnects.",
        }),
    ),
  );
  if (!current.enableAgentDeviceAccess) return yield* agentDeviceAccessDisabled();
  return scope;
});

export const resolveHostId = Effect.fn("handlers.resolveHostId")(function* (
  hosts: ReadonlyArray<DeviceHostSummary>,
  hostId: string | undefined,
): Effect.fn.Return<DeviceHostId | undefined, DeviceToolUnavailableError> {
  if (!hostId) return undefined;
  const exact = hosts.find((host) => host.id === hostId);
  if (exact) return exact.id;
  const labelMatches = hosts.filter((host) => host.label.toLowerCase() === hostId.toLowerCase());
  if (labelMatches.length === 1) return labelMatches[0]!.id;
  const candidates = labelMatches.length > 1 ? labelMatches : hosts;
  const listed = [
    ...candidates.slice(0, 10).map((host) => `${host.label.slice(0, 64)} (${host.id})`),
    ...(candidates.length > 10 ? [`${candidates.length - 10} more`] : []),
  ].join(", ");
  const selector = hostId.slice(0, 128);
  return yield* new DeviceToolUnavailableError({
    reason:
      labelMatches.length > 1
        ? `Several device hosts are named ${selector}; pass one id: ${listed}.`
        : `No device host ${selector}. Known hosts: ${listed || "none"}.`,
  });
});

const hostName = (host: { readonly id: DeviceHostId; readonly label?: string | undefined }) =>
  host.label === undefined ? `hostId ${host.id}` : `'${host.label}' (hostId ${host.id})`;

const mapLocateErrors = <A, R>(
  effect: Effect.Effect<
    A,
    DeviceService.DeviceHostAmbiguousError | DeviceService.DeviceOnOtherHostError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      DeviceHostAmbiguousError: (error) =>
        Effect.fail(
          new DeviceToolUnavailableError({
            reason: `Device ${error.deviceId} is on more than one host: ${error.hosts.map(hostName).join(", ")}. Pass hostId.`,
          }),
        ),
      DeviceOnOtherHostError: (error) =>
        Effect.fail(
          new DeviceToolUnavailableError({
            reason: `Device ${error.deviceId} is not on ${hostName(error.host)}. It is on ${error.hosts.map(hostName).join(", ")}; pass that hostId.`,
          }),
        ),
    }),
  );

const failedHosts = <H extends { readonly id: DeviceHostId }>(
  state: { readonly hostStatuses: DeviceServiceState["hostStatuses"] },
  hosts: ReadonlyArray<H>,
) =>
  hosts.flatMap((host) => {
    const status = state.hostStatuses[host.id];
    return status?.status === "failed" && status.detail ? [{ host, detail: status.detail }] : [];
  });

const pickDevice = Effect.fn("handlers.pickDevice")(function* (
  state: {
    readonly hosts: ReadonlyArray<DeviceHostSummary>;
    readonly hostStatuses: DeviceServiceState["hostStatuses"];
    readonly devices: ReadonlyArray<DeviceSummary>;
  },
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
  },
): Effect.fn.Return<DeviceSummary, DeviceToolUnavailableError, DeviceService.DeviceService> {
  if (input.deviceId !== undefined) {
    const { deviceId, hostId } = input;
    const devices = yield* DeviceService.DeviceService;
    const located = yield* devices.locateDevice({ deviceId, hostId }).pipe(mapLocateErrors);
    if (Option.isSome(located)) return located.value;
    const target =
      hostId === undefined
        ? undefined
        : (state.hosts.find((host) => host.id === hostId) ?? { id: hostId });
    const failures = failedHosts(state, target === undefined ? state.hosts : [target]).map(
      ({ host, detail }) => `${hostName(host)} failed to start: ${detail}`,
    );
    return yield* new DeviceToolUnavailableError({
      reason: [
        `No device ${deviceId} on ${target === undefined ? "any host" : hostName(target)}.`,
        ...failures,
        "Call device_list for current ids.",
      ].join(" "),
    });
  }
  const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
  const candidates = state.devices.filter(
    (device) =>
      device.hostId === hostId &&
      (input.platform === undefined || device.platform === input.platform),
  );
  if (candidates.length === 0) {
    const [failure] = failedHosts(state, [{ id: hostId }]);
    return yield* new DeviceToolUnavailableError({
      reason:
        failure !== undefined
          ? failure.detail
          : input.platform === undefined
            ? "No simulators or emulators were found. Call device_list to see why."
            : `No ${input.platform} devices were found on host ${hostId}. Call device_list to see why.`,
    });
  }
  const platforms = new Set(candidates.map((device) => device.platform));
  if (input.platform === undefined && platforms.size > 1) {
    return yield* new DeviceToolUnavailableError({
      reason: "Both iOS and Android devices are available; pass platform or deviceId.",
    });
  }
  return candidates.find((device) => device.booted) ?? candidates[0]!;
});

const toolError = (error: DeviceError | DeviceToolUnavailableError | VirtualMachineError) => error;

const virtualMachineQuickStart = (
  guest: VirtualMachineGuest | null | undefined,
  otherThreads: number,
) =>
  [
    "The user is watching this macOS VM in the Device panel. Everything runs inside the guest, not on the host Mac. Build, test and launch the app under test here, not on the host.",
    guest
      ? [
          `Guest: macOS ${guest.macos}, ${guest.cpu ?? "?"} CPUs, ${guest.memoryGb ?? "?"} GB memory, ${guest.diskFreeGb ?? "?"} GB free, user ${guest.user}.`,
          guest.xcode
            ? `${guest.xcode} is installed, so xcodebuild and XCTest run here.`
            : "No Xcode is installed, only what the Command Line Tools provide. xcodebuild and XCTest will not run here, so tell the user if the task needs them.",
        ].join(" ")
      : "The guest did not answer the capability probe. Check its tools with vm_exec before planning around them.",
    "vm_exec runs a shell command and takes cwd and timeoutSeconds. Start a build or test suite with background: true and read it with vm_job, so a long run cannot hit the limit.",
    "No host folder is mounted. vm_upload copies one workspace file in and vm_download copies one guest file back. For a source tree or app bundle, make a tar archive, copy it, and unpack it on the other side. Source editing and Git stay in the working repository.",
    "vm_tools lists the Cua desktop tools, vm_tools with tools: [names] returns their schemas, vm_control calls one, and device_screenshot with virtualMachine looks at the screen. Synthetic key events may not trigger an app's registered global hot keys; send those with osascript and System Events.",
    guest?.passwordlessSudo
      ? "sudo needs no password."
      : "sudo asks for a password. Images from Cua and Lume set it to the user name, so pipe that to sudo -S. If it fails, ask the user.",
    guest?.sipEnabled === false
      ? "SIP is off, so grant an app Accessibility, Screen Recording or Input Monitoring by adding rows to /Library/Application Support/com.apple.TCC/TCC.db with sudo sqlite3, using the app's code requirement from codesign -dr -."
      : "Grant an app Accessibility or Screen Recording through System Settings with vm_control.",
    otherThreads > 0
      ? `${otherThreads} other thread${otherThreads === 1 ? " has" : "s have"} this VM open. device_close with shutdown: true suspends it for all of them, so close without shutdown.`
      : "device_close releases this thread's session and leaves the VM running. shutdown: true suspends it for every thread and the user.",
    "Replay drags, shortcuts and animations before reporting them verified.",
  ].join("\n");

const hostRunsVirtualMachines = Effect.gen(function* () {
  return (
    (yield* HostProcess.Platform) === "darwin" && (yield* HostProcess.Architecture) === "arm64"
  );
});

/** VMs are listed beside devices only where Lume can run them. */
const listVirtualMachines = Effect.fn("handlers.listVirtualMachines")(function* (
  threadId: ThreadId,
) {
  if (!(yield* hostRunsVirtualMachines)) return undefined;
  const vms = yield* VirtualMachineService.VirtualMachineService;
  // A failed inventory refresh still reports the last known machines.
  const state = yield* vms.list.pipe(Effect.catch(() => vms.state));
  const openInOtherThreads: Record<string, number> = {};
  for (const session of state.sessions)
    if (session.threadId !== threadId)
      openInOtherThreads[session.name] = (openInOtherThreads[session.name] ?? 0) + 1;
  // Listing still works when Lume cannot be read; the host inventory is then left out.
  const host = state.enabled
    ? yield* vms.hostInventory.pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  return {
    enabled: state.enabled,
    available: state.available,
    unavailableReason: state.unavailableReason,
    machines: state.machines,
    operations: state.operations,
    open: state.sessions
      .filter((session) => session.threadId === threadId)
      .map((session) => session.name),
    guests: yield* vms.knownGuests,
    openInOtherThreads,
    ...(host === undefined ? {} : { host }),
  };
});

const openVirtualMachineNames = Effect.fn("handlers.openVirtualMachineNames")(function* (
  threadId: ThreadId,
) {
  const vms = yield* VirtualMachineService.VirtualMachineService;
  return (yield* vms.state).sessions
    .filter((session) => session.threadId === threadId)
    .map((session) => session.name);
});

const vmScreenshot = Effect.fn("handlers.vmScreenshot")(function* (
  threadId: ThreadId,
  name: string,
) {
  const vms = yield* VirtualMachineService.VirtualMachineService;
  const shot = yield* vms.screenshot(threadId, name);
  return { virtualMachine: shot.name, screenshot: shot.screenshot };
});

const handlers = {
  device_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      const virtualMachines = yield* listVirtualMachines(scope.thread.threadId);
      if (state.hostStatus === "disabled" && !virtualMachines?.enabled) {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const hostId = yield* resolveHostId(state.hosts, input?.hostId);
      const open = state.sessions
        .filter((session) => session.threadId === scope.thread.threadId)
        .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId }));
      return {
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => !hostId || id === hostId),
        ),
        hosts: hostId ? state.hosts.filter((host) => host.id === hostId) : state.hosts,
        devices: hostId
          ? state.devices.filter((device) => device.hostId === hostId)
          : state.devices,
        open,
        ...(virtualMachines === undefined ? {} : { virtualMachines }),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      if (input.virtualMachine !== undefined) {
        const vms = yield* VirtualMachineService.VirtualMachineService;
        const threadId = scope.thread.threadId;
        yield* vms.open({ name: input.virtualMachine, threadId });
        // The VM is open either way. A guest that cannot answer yet only loses the summary.
        const guest = yield* vms
          .inspect(threadId, input.virtualMachine)
          .pipe(Effect.orElseSucceed(() => null));
        const otherThreads = yield* vms.otherSessions(threadId, input.virtualMachine);
        return {
          virtualMachine: input.virtualMachine,
          quickStart: virtualMachineQuickStart(guest, otherThreads),
          guest,
          otherThreads,
        };
      }
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const hostId = yield* resolveHostId(state.hosts, input.hostId);
      const target = yield* pickDevice(state, { ...input, hostId });
      // Resolve consent and agent connectivity before booting or registering a session.
      if (!(yield* devices.agentReadinessIfSupported(target.hostId))) {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.",
        });
      }
      const session = yield* devices.open(
        {
          threadId: scope.thread.threadId,
          hostId: target.hostId,
          deviceId: target.id,
          platform: target.platform,
        },
        { workspaceRoot: yield* threadWorkspaceRoot(scope.thread.threadId) },
      );
      const after = yield* devices.state;
      const device =
        after.devices.find(
          (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
        ) ?? target;
      // Target the opened device: an EAS device and its agent-device daemon
      // exist only once its session runs, and Android ids change on boot.
      const opened = {
        threadId: scope.thread.threadId,
        hostId: session.hostId,
        deviceId: session.deviceId,
      };
      const agent = yield* devices.agentTarget(opened);
      const hostKind = after.hosts.find((host) => host.id === device.hostId)?.kind;
      const targetArgs = [
        ...(agent.agentDeviceId === null
          ? []
          : agentDeviceTargetArgs({ ...device, id: agent.agentDeviceId })),
        ...agent.args,
      ];
      const launcher = yield* devices.agentLauncher({ ...opened, targetArgs });
      if (Option.isNone(launcher)) {
        return yield* new DeviceToolUnavailableError({
          reason:
            "The device was closed while device_open was preparing it. Call device_open again only if you still need it.",
        });
      }
      const command = launcher.value;
      return {
        device,
        agentDevice: { command, targetArgs, session: agent.session },
        quickStart: agentDeviceQuickStart(
          device,
          [],
          command,
          hostKind === "simlock"
            ? {
                kind: "simlock",
                ...(agent.installDirectory ? { installDirectory: agent.installDirectory } : {}),
              }
            : hostKind === "eas"
              ? { kind: "eas" }
              : undefined,
        ),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const threadId = scope.thread.threadId;
      if (input.virtualMachine !== undefined)
        return yield* vmScreenshot(threadId, input.virtualMachine);
      const devices = yield* DeviceService.DeviceService;
      const hostId =
        input.hostId === undefined
          ? undefined
          : yield* resolveHostId((yield* devices.state).hosts, input.hostId);
      const target =
        input.deviceId === undefined
          ? (yield* devices.sessionsForThread(threadId)).findLast(
              (session) => hostId === undefined || session.hostId === hostId,
            )
          : Option.getOrUndefined(
              yield* devices
                .locateSession({ threadId, deviceId: input.deviceId, hostId })
                .pipe(mapLocateErrors),
            );
      if (!target && input.deviceId === undefined && hostId === undefined) {
        const openVirtualMachine = (yield* openVirtualMachineNames(threadId)).at(-1);
        if (openVirtualMachine !== undefined)
          return yield* vmScreenshot(threadId, openVirtualMachine);
      }
      if (!target) {
        return yield* new DeviceToolUnavailableError({
          reason:
            input.deviceId === undefined
              ? "No device is open in this thread. Call device_open first."
              : `Device ${input.deviceId} is not open in this thread. Call device_open first.`,
        });
      }
      const shot = yield* devices.screenshot(target);
      return {
        device: shot.device,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(shot.png).toString("base64"),
          ...pngDimensions(shot.png),
        },
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const threadId = scope.thread.threadId;
      const vms = yield* VirtualMachineService.VirtualMachineService;
      // An agent's suspend would silently end other threads' sessions, so it may only
      // suspend a VM no other thread holds. The user can still suspend from the panel.
      const closeVirtualMachine = Effect.fn("handlers.closeVirtualMachine")(function* (
        name: string,
      ) {
        if (!input.shutdown) return yield* vms.close({ name, threadId });
        const otherThreads = yield* vms.otherSessions(threadId, name);
        if (otherThreads > 0)
          return yield* new VirtualMachineError({
            operation: "stop",
            reason: "shared",
            otherThreads,
          });
        yield* vms.stop(name);
      });
      if (input.virtualMachine !== undefined) {
        yield* closeVirtualMachine(input.virtualMachine);
        return {};
      }
      const devices = yield* DeviceService.DeviceService;
      const deviceId = input.deviceId;
      const inputHostId =
        input.hostId === undefined
          ? undefined
          : yield* resolveHostId((yield* devices.state).hosts, input.hostId);
      const open =
        deviceId === undefined
          ? Option.none()
          : yield* devices
              .locateSession({ threadId: scope.thread.threadId, deviceId, hostId: inputHostId })
              .pipe(mapLocateErrors);
      const hostId = Option.isSome(open) ? open.value.hostId : inputHostId;
      yield* devices.close({
        threadId: scope.thread.threadId,
        ...(hostId === undefined ? {} : { hostId }),
        ...(deviceId === undefined ? {} : { deviceId }),
        ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
      });
      // Closing everything here includes this thread's VMs.
      if (deviceId === undefined && inputHostId === undefined) {
        for (const name of yield* openVirtualMachineNames(threadId))
          yield* closeVirtualMachine(name);
      }
      return {};
    }).pipe(Effect.mapError(toolError)),
  ),
} satisfies McpToolAccess.Handlers<typeof DeviceToolkit.tools>;

export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452;
  return isPng
    ? { width: view.getUint32(16), height: view.getUint32(20) }
    : { width: 0, height: 0 };
}

const { device_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(DeviceStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(DeviceScreenshotToolkit, {
  device_screenshot,
});
