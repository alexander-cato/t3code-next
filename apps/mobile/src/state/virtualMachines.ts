import { createVirtualMachineEnvironmentAtoms } from "@t3tools/client-runtime/state/virtual-machines";
import type { EnvironmentId } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";

export const virtualMachineEnvironment =
  createVirtualMachineEnvironmentAtoms(connectionAtomRuntime);

/** VM state for environments whose server lists VMs as devices; null elsewhere. */
export function useVirtualMachineState(environmentId: EnvironmentId | null) {
  const supported =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.virtualMachines === true;
  return useEnvironmentQuery(
    supported && environmentId !== null
      ? virtualMachineEnvironment.state({ environmentId, input: {} })
      : null,
  );
}
