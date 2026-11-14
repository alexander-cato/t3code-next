import {
  DeviceToolUnavailableError,
  OrchestratorMcpFailure,
  VirtualMachineControlInput,
  VirtualMachineCreateInput,
  VirtualMachineDownloadInput,
  VirtualMachineError,
  VirtualMachineExecInput,
  VirtualMachineExecResult,
  VirtualMachineJobInput,
  VirtualMachineJobResult,
  VirtualMachineTarget,
  VirtualMachineToolsInput,
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
    "Create a local macOS VM with Cua desktop control. Without from it downloads a new macOS Tahoe image with the Command Line Tools, which takes a long time and about 60 GB of disk. With from it clones a suspended VM in seconds, keeping its installed apps such as Xcode, so a task can start from a prepared base and throw the clone away with vm_delete. Returns at once; device_list reports progress and failures. A new VM starts running and takes one of the two macOS VM slots. Host files are not shared.",
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
    "Run a shell command inside a VM opened in this thread with device_open. Returns stdout, stderr and exitCode; a command stopped at timeoutSeconds returns exitCode 124. Use for builds, tests, installing an app, logs and guest files. For work that may outlast the timeout, such as a full build or test suite, pass background: true and read it with vm_job. Commands run in the guest, not on the host Mac, as children of the guest's desktop agent, so they reach the logged-in GUI session. No host folders are mounted, so bring source in with vm_upload and results out with vm_download.",
  parameters: VirtualMachineExecInput,
  success: VirtualMachineExecResult,
  failure,
  dependencies,
}).annotate(Tool.Readonly, false);
const job = Tool.make("vm_job", {
  description:
    "Read a background job that vm_exec started with background: true. Returns its state, exit code and the end of its combined output. The full log stays in the guest at logPath. stop: true ends the job first. Jobs survive closing and suspending the VM, not deleting it.",
  parameters: VirtualMachineJobInput,
  success: VirtualMachineJobResult,
  failure,
  dependencies,
}).annotate(Tool.Readonly, false);
const tools = Tool.make("vm_tools", {
  description:
    "List the Cua desktop tools of an open VM. Without tools it returns each tool's name and description; pass tools with the names you need to get their JSON schemas for vm_control. They inspect windows and accessibility, click, drag, type, send shortcuts, and control guest apps. Prefer element references when available.",
  parameters: VirtualMachineToolsInput,
  success: Schema.Union([
    Schema.Array(McpSchema.Tool),
    Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) }),
      ),
    }),
  ]),
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
const download = Tool.make("vm_download", {
  description:
    "Copy one file from an open VM into this thread's workspace, such as a test report, log, screenshot or built archive. guestPath is an absolute guest path. relativePath must stay inside the workspace and its directory must exist; an existing regular file is replaced. For a directory, tar it in the guest with vm_exec first.",
  parameters: VirtualMachineDownloadInput,
  success: Schema.Struct({ message: Schema.String, bytes: Schema.Number }),
  failure,
  dependencies: [...dependencies, ProjectService.ProjectService],
}).annotate(Tool.Readonly, false);
export const VmStandardToolkit = Toolkit.make(create, remove, exec, job, tools, upload, download);
export const VmControlToolkit = Toolkit.make(VmControlTool);
