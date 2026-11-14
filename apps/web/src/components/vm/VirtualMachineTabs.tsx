import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelSurface } from "~/rightPanelStore";
import { VirtualMachineDeviceView } from "./VirtualMachineDeviceView";

/** VM tabs stay mounted while hidden: remounting one reopens the VM and restarts its desktop stream. */
export function VirtualMachineTabs(props: {
  readonly threadRef: ScopedThreadRef;
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
  readonly activeSurfaceId: string | null;
  readonly visible: boolean;
}) {
  const threadKey = scopedThreadKey(props.threadRef);
  return (
    props.surfaces
      .flatMap((surface) =>
        surface.kind === "device" && surface.virtualMachine !== undefined
          ? [{ id: surface.id, name: surface.virtualMachine }]
          : [],
      )
      // Tab order is not used: moving an iframe in the DOM reloads it.
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map(({ id, name }) => {
        const active = id === props.activeSurfaceId;
        return (
          <div key={`${threadKey}:${id}`} hidden={!active} className="flex min-h-0 flex-1 flex-col">
            <VirtualMachineDeviceView
              threadRef={props.threadRef}
              placement={{ kind: "tab", surfaceId: id }}
              name={name}
              visible={props.visible && active}
            />
          </div>
        );
      })
  );
}
