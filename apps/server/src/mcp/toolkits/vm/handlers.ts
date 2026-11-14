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
      return {
        message:
          input.from === undefined
            ? "VM creation started. device_list reports progress and any failure."
            : `Cloning ${input.from} started. device_list reports progress and any failure.`,
      };
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
  vm_job: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const vms = yield* VirtualMachineService.VirtualMachineService;
      return yield* vms.job(scope.thread.threadId, input);
    }),
  ),
  vm_download: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const vms = yield* VirtualMachineService.VirtualMachineService;
      const { bytes } = yield* vms.download(scope.thread.threadId, input);
      return { message: "The file was copied into the workspace.", bytes };
    }),
  ),
  vm_tools: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const vms = yield* VirtualMachineService.VirtualMachineService;
      const tools = yield* vms.tools(scope.thread.threadId, input.name);
      // Every schema together is over 150 KB, more than an agent can take in one result.
      if (input.tools !== undefined)
        return tools.filter((tool) => input.tools!.includes(tool.name));
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description.slice(0, 240) } : {}),
        })),
      };
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
