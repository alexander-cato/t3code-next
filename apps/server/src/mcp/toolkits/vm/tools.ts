import {
  DeviceToolUnavailableError,
  OrchestratorMcpFailure,
  VirtualMachineControlInput,
  VirtualMachineCreateInput,
  VirtualMachineError,
  VirtualMachineExecInput,
  VirtualMachineExecResult,
  VirtualMachineTarget,
  VirtualMachineUploadInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";

import * as VirtualMachineService from "../../../vm/VirtualMachineService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectService from "../../../project/ProjectService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  VirtualMachineService.VirtualMachineService,
  ServerSettings.ServerSettingsService,
];
// Agents reach VMs under the same Agent device access consent as simulators.
const failure = Schema.Union([
  VirtualMachineError,
  DeviceToolUnavailableError,
  OrchestratorMcpFailure,
]);
const done = Schema.Struct({ message: Schema.String });

const create = Tool.make("vm_create", {
  description:
    "Create a local macOS Tahoe VM with Cua desktop control and development tools. Returns immediately while the image downloads and the VM starts. device_list reports creation progress and failures. Requires substantial free disk space; source and host files are not shared automatically.",
  parameters: VirtualMachineCreateInput,
  success: done,
  failure,
  dependencies,
}).annotate(Tool.Readonly, false);
const remove = Tool.make("vm_delete", {
  description:
    "Permanently delete a T3-managed local macOS VM and its guest files. Suspend it first with device_close shutdown: true. Use only when the user wants this VM removed.",
  parameters: VirtualMachineTarget,
  success: done,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true);
const exec = Tool.make("vm_exec", {
  description:
    "Run a shell command inside a VM opened in this thread with device_open. Returns stdout, stderr and exitCode. Use for builds, installing a test app, logs, guest files and diagnostic scripts. Commands run inside the guest, not on the host Mac. Copy source or build artifacts into the guest explicitly; no host folders are mounted.",
  parameters: VirtualMachineExecInput,
  success: VirtualMachineExecResult,
  failure,
  dependencies,
}).annotate(Tool.Readonly, false);
const tools = Tool.make("vm_tools", {
  description:
    "Get the current Cua desktop tool names and JSON schemas from an open VM. Use these schemas with vm_control to inspect windows and accessibility, click, drag, type, send shortcuts, and control guest apps. Prefer element references when available.",
  parameters: VirtualMachineTarget,
  success: Schema.Array(McpSchema.Tool),
  failure,
  dependencies,
}).annotate(Tool.Readonly, true);
export const VmControlTool = Tool.make("vm_control", {
  description:
    "Call one Cua desktop automation tool inside a VM opened in this thread with device_open. Get the tool's exact name and arguments with vm_tools first. For accessibility actions, pass the target app pid alongside its element_token. Each VM keeps its own guest MCP connection for this thread, so element tokens and repeated session labels work across calls. Use a session label unique to this thread and VM or omit session. If the guest reports session_ended, use start_session to revive it and fetch fresh element tokens. Closing or suspending a VM ends its connection; fetch fresh element tokens after reopening. This controls the guest desktop without taking over the host Mac.",
  parameters: VirtualMachineControlInput,
  success: McpSchema.CallToolResult,
  failure,
  dependencies,
}).annotate(Tool.Readonly, false);
const upload = Tool.make("vm_upload", {
  description:
    "Copy one file from this thread's workspace into an open VM. relativePath must stay inside the workspace, including symlink targets. guestPath is an absolute guest path. For an app bundle or source directory, create a tar or zip archive in the workspace, upload it, then unpack with vm_exec. Host folders are never mounted.",
  parameters: VirtualMachineUploadInput,
  success: done,
  failure,
  dependencies: [...dependencies, ProjectService.ProjectService],
}).annotate(Tool.Readonly, false);
export const VmStandardToolkit = Toolkit.make(create, remove, exec, tools, upload);
export const VmControlToolkit = Toolkit.make(VmControlTool);
