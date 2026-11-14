import type { DeviceServiceState, ThreadId, VirtualMachineState } from "@t3tools/contracts";

import { threadDevicePreviews, virtualMachinePreviewKey } from "./threadDevicePreviews";

export interface ThreadDevicesMenuItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: "iphone" | "desktopcomputer";
  readonly disabled: boolean;
  /** The device preview key to open. */
  readonly deviceKey: string;
}

/** What is open in the thread, then the macOS VMs this connection can open there. */
export function threadDevicesMenuItems(input: {
  readonly threadId: ThreadId;
  readonly devices: DeviceServiceState | null;
  readonly virtualMachines: VirtualMachineState | null | undefined;
  readonly canOpenVirtualMachines: boolean;
}): ReadonlyArray<ThreadDevicesMenuItem> {
  const previews = threadDevicePreviews(input.devices, input.threadId, input.virtualMachines);
  const open = new Set(previews.map((preview) => preview.key));
  const virtualMachines = input.virtualMachines;
  return [
    ...previews.map((preview) => ({
      id: preview.key,
      title: preview.name,
      subtitle: preview.description,
      icon: preview.kind === "vm" ? ("desktopcomputer" as const) : ("iphone" as const),
      disabled: false,
      deviceKey: preview.key,
    })),
    ...(virtualMachines?.enabled && virtualMachines.available
      ? virtualMachines.machines
          .filter(
            (machine) =>
              !open.has(virtualMachinePreviewKey(machine.name)) &&
              !virtualMachines.operations.some(
                (operation) => operation.name === machine.name && operation.status === "creating",
              ),
          )
          .map((machine) => {
            const running = machine.status === "running" || machine.status === "ready";
            return {
              id: `open:${machine.name}`,
              title: `${running ? "Open" : "Start"} ${machine.name}`,
              subtitle: "macOS virtual machine",
              icon: "desktopcomputer" as const,
              disabled: !input.canOpenVirtualMachines,
              deviceKey: virtualMachinePreviewKey(machine.name),
            };
          })
      : []),
  ];
}
