import { useAtomValue } from "@effect/atom-react";
import {
  environmentSessionGenerationAtom,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { createVirtualMachineEnvironmentAtoms } from "@t3tools/client-runtime/state/virtual-machines";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";

export const virtualMachineEnvironment =
  createVirtualMachineEnvironmentAtoms(connectionAtomRuntime);

const idleDiscovery = Atom.make(undefined);
const discover = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const generation = get(environmentSessionGenerationAtom(connectionAtomRuntime, environmentId));
    const allowed = get(virtualMachineEnvironment.list.permissionAtom(environmentId));
    if (generation === 0 || !allowed) return;
    // Only the subscription publishes inventory; a retired session's list reply cannot replace it.
    void runAtomCommand(get.registry, virtualMachineEnvironment.list, { environmentId, input: {} });
  }).pipe(Atom.withLabel(`mobile-vm-discovery:${environmentId}`)),
);

/** VM state for environments whose server lists VMs as devices; null elsewhere. */
export function useVirtualMachineState(environmentId: EnvironmentId | null) {
  const supported =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.virtualMachines === true;
  useAtomValue(supported && environmentId !== null ? discover(environmentId) : idleDiscovery);
  return useEnvironmentQuery(
    supported && environmentId !== null
      ? virtualMachineEnvironment.state({ environmentId, input: {} })
      : null,
  );
}
