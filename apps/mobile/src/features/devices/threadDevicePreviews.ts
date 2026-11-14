import type { DeviceServiceState, ThreadId, VirtualMachineState } from "@t3tools/contracts";

export const virtualMachinePreviewKey = (name: string) => JSON.stringify(["vm", name]);

export interface RequestedVirtualMachine {
  readonly name: string;
  readonly closedSessionId: string | null;
}

/**
 * Host identity is part of the selection because Android serials repeat across hosts.
 * `requestedVirtualMachine` is a VM the user just chose to open; it shows before its session does.
 */
export function threadDevicePreviews(
  state: DeviceServiceState | null,
  threadId: ThreadId,
  virtualMachines?: VirtualMachineState | null,
  requestedVirtualMachine?: RequestedVirtualMachine,
) {
  const devices = (state?.sessions ?? [])
    .filter((session) => session.threadId === threadId)
    .map((session) => {
      const device = state?.devices.find(
        (device) => device.hostId === session.hostId && device.id === session.deviceId,
      );
      const host = state?.hosts.find((host) => host.id === session.hostId);
      return {
        kind: "device" as const,
        key: JSON.stringify([session.hostId, session.deviceId]),
        session,
        name: device?.name ?? (session.platform === "ios" ? "iOS Simulator" : "Android Emulator"),
        description: [device?.version, host?.label].filter(Boolean).join(" · "),
        serveSimOnly: host?.kind === "simlock",
      };
    });
  const names = new Set(
    virtualMachines?.enabled
      ? virtualMachines.sessions
          .filter(
            (session) =>
              session.threadId === threadId &&
              !virtualMachines.machines.some(
                (machine) => machine.name === session.name && machine.status === "stopped",
              ),
          )
          .map((session) => session.name)
      : [],
  );
  if (requestedVirtualMachine !== undefined && virtualMachines?.enabled) {
    const closed = virtualMachines.closedSessions?.find(
      (session) => session.threadId === threadId && session.name === requestedVirtualMachine.name,
    );
    if (!closed || closed.id === requestedVirtualMachine.closedSessionId)
      names.add(requestedVirtualMachine.name);
  }
  return [
    ...devices,
    ...[...names].map((name) => ({
      kind: "vm" as const,
      key: virtualMachinePreviewKey(name),
      name,
      description: "macOS virtual machine",
    })),
  ];
}

export type ThreadDevicePreview = ReturnType<typeof threadDevicePreviews>[number];

export function selectedThreadDevicePreview(
  previews: ReadonlyArray<ThreadDevicePreview>,
  selectedKey: string | null,
) {
  return previews.find((preview) => preview.key === selectedKey) ?? previews[0] ?? null;
}
