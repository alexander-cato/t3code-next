import * as Effect from "effect/Effect";
import * as VirtualMachineService from "../../../vm/VirtualMachineService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { requireDeviceAccess } from "../device/handlers.ts";
import { VmControlToolkit, VmStandardToolkit } from "./tools.ts";

export const layerStandard = McpToolAccess.toLayer(VmStandardToolkit, {
  vm_upload: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const vms = yield* VirtualMachineService.VirtualMachineService;
      yield* vms.upload(scope.thread.threadId, input);
      return { message: "The file was copied into the VM." };
    }),
  ),
  vm_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireDeviceAccess;
      const vms = yield* VirtualMachineService.VirtualMachineService;
      yield* vms.create(input);
      return { message: "VM creation started. device_list reports progress and any failure." };
    }),
  ),
  vm_delete: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireDeviceAccess;
      const vms = yield* VirtualMachineService.VirtualMachineService;
      yield* vms.remove(input.name);
      return { message: "The VM and its guest files were deleted." };
    }),
  ),
  vm_exec: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const vms = yield* VirtualMachineService.VirtualMachineService;
      return yield* vms.exec(scope.thread.threadId, input);
    }),
  ),
  vm_tools: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const vms = yield* VirtualMachineService.VirtualMachineService;
      return yield* vms.tools(scope.thread.threadId, input.name);
    }),
  ),
});

export const layerControl = McpToolAccess.toLayer(VmControlToolkit, {
  vm_control: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const vms = yield* VirtualMachineService.VirtualMachineService;
      return yield* vms.control(scope.thread.threadId, input);
    }),
  ),
});
