import { createVirtualMachineEnvironmentAtoms } from "@t3tools/client-runtime/state/virtual-machines";
import type { EnvironmentId } from "@t3tools/contracts";
import { useServerConfigs } from "./entities";
import { connectionAtomRuntime } from "../connection/runtime";

export const virtualMachineEnvironment =
  createVirtualMachineEnvironmentAtoms(connectionAtomRuntime);

export function useVirtualMachinesSupported(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.virtualMachines === true
  );
}
