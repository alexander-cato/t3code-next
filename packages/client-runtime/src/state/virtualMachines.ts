import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createVirtualMachineEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:vm:state",
      tag: WS_METHODS.subscribeVirtualMachines,
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm:list",
      tag: WS_METHODS.virtualMachineList,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm:configure",
      tag: WS_METHODS.virtualMachineConfigure,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm:create",
      tag: WS_METHODS.virtualMachineCreate,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm:open",
      tag: WS_METHODS.virtualMachineOpen,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm:close",
      tag: WS_METHODS.virtualMachineClose,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm:stop",
      tag: WS_METHODS.virtualMachineStop,
    }),
    dismiss: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm:dismiss",
      tag: WS_METHODS.virtualMachineDismiss,
    }),
    screenshot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm:screenshot",
      tag: WS_METHODS.virtualMachineScreenshot,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vm:remove",
      tag: WS_METHODS.virtualMachineDelete,
    }),
  };
}

export function virtualMachineViewerUrl(httpBaseUrl: string, viewerPath: string): string {
  const url = new URL(viewerPath, httpBaseUrl);
  url.searchParams.set("clipboard", "off");
  url.searchParams.set("audio", "off");
  return url.toString();
}
