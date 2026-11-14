import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VirtualMachineName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);

export const VirtualMachineTarget = Schema.Struct({ name: VirtualMachineName });
export type VirtualMachineTarget = typeof VirtualMachineTarget.Type;

export const VirtualMachineCreateInput = Schema.Struct({
  name: VirtualMachineName,
  cpu: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 16 })).annotate({
    description: "vCPUs for a new VM. A clone keeps its source's.",
  }),
  memoryGb: Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: 64 })).annotate({
    description: "Memory in GB for a new VM. A clone keeps its source's.",
  }),
  from: Schema.optional(
    VirtualMachineName.annotate({
      description:
        "Clone this suspended VM instead of downloading a new one. The clone is a new machine with the source's disk, apps and permission grants, ready in seconds.",
    }),
  ),
});
export type VirtualMachineCreateInput = typeof VirtualMachineCreateInput.Type;

export const VirtualMachineOpenInput = Schema.Struct({
  name: VirtualMachineName,
  threadId: ThreadId,
});
export type VirtualMachineOpenInput = typeof VirtualMachineOpenInput.Type;

const VirtualMachineSession = Schema.Struct({
  name: VirtualMachineName,
  threadId: ThreadId,
});

const VirtualMachine = Schema.Struct({
  name: VirtualMachineName,
  status: Schema.String,
});

export const VirtualMachineState = Schema.Struct({
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(Schema.String),
  machines: Schema.Array(VirtualMachine),
  sessions: Schema.Array(VirtualMachineSession),
  // Explicit closes must remain distinguishable from sessions lost on server restart.
  closedSessions: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...VirtualMachineSession.fields, id: Schema.String })),
  ),
  operations: Schema.Array(
    Schema.Struct({
      name: VirtualMachineName,
      status: Schema.Literals(["creating", "failed"]),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type VirtualMachineState = typeof VirtualMachineState.Type;

export const VirtualMachineViewer = Schema.Struct({
  name: VirtualMachineName,
  viewerPath: Schema.String,
  // Relative, so clients schedule renewal on their own clock.
  expiresInMs: Schema.Number,
});
export type VirtualMachineViewer = typeof VirtualMachineViewer.Type;

const GuestPath = TrimmedNonEmptyString.check(Schema.isMaxLength(1024), Schema.isPattern(/^\//));

export const VirtualMachineExecInput = Schema.Struct({
  name: VirtualMachineName,
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(128_000)),
  cwd: Schema.optional(
    GuestPath.annotate({ description: "Absolute guest directory to run in. Default: home." }),
  ),
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })).annotate({
      description: "Seconds before the command is stopped with exitCode 124. Default 300.",
    }),
  ),
  background: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Start the command detached and return a jobId at once. Read it with vm_job. Use for anything that may outlast timeoutSeconds.",
    }),
  ),
});
export type VirtualMachineExecInput = typeof VirtualMachineExecInput.Type;

export const VirtualMachineJobId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{12}$/));
export const VirtualMachineExecResult = Schema.Union([
  Schema.Struct({ stdout: Schema.String, stderr: Schema.String, exitCode: Schema.Number }),
  Schema.Struct({ jobId: VirtualMachineJobId, logPath: Schema.String }),
]);
export type VirtualMachineExecResult = typeof VirtualMachineExecResult.Type;

export const VirtualMachineJobInput = Schema.Struct({
  name: VirtualMachineName,
  jobId: VirtualMachineJobId,
  tailBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })).annotate({
      description: "Bytes of combined output to return from the end of the log. Default 16000.",
    }),
  ),
  stop: Schema.optional(
    Schema.Boolean.annotate({ description: "Terminate the job before reading it." }),
  ),
});
export type VirtualMachineJobInput = typeof VirtualMachineJobInput.Type;
export const VirtualMachineJobResult = Schema.Struct({
  // `lost` means the job's process is gone without an exit code, as after a guest restart.
  state: Schema.Literals(["running", "exited", "lost"]),
  exitCode: Schema.NullOr(Schema.Number),
  output: Schema.String,
  logPath: Schema.String,
});
export type VirtualMachineJobResult = typeof VirtualMachineJobResult.Type;

export const VirtualMachineGuest = Schema.Struct({
  macos: Schema.String,
  cpu: Schema.NullOr(Schema.Number),
  memoryGb: Schema.NullOr(Schema.Number),
  diskFreeGb: Schema.NullOr(Schema.Number),
  user: Schema.String,
  // Null without a full Xcode. The Command Line Tools alone cannot run xcodebuild or XCTest.
  xcode: Schema.NullOr(Schema.String),
  swift: Schema.NullOr(Schema.String),
  homebrew: Schema.Boolean,
  sipEnabled: Schema.NullOr(Schema.Boolean),
  passwordlessSudo: Schema.Boolean,
});
export type VirtualMachineGuest = typeof VirtualMachineGuest.Type;

export const VirtualMachineHostMachine = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  cpu: Schema.NullOr(Schema.Number),
  memoryGb: Schema.NullOr(Schema.Number),
  // False for Lume VMs other tools created; T3 lists them but cannot open them.
  managed: Schema.Boolean,
});
export const VirtualMachineHostInventory = Schema.Struct({
  runningLimit: Schema.Number,
  machines: Schema.Array(VirtualMachineHostMachine),
});
export type VirtualMachineHostInventory = typeof VirtualMachineHostInventory.Type;

export const VirtualMachineControlInput = Schema.Struct({
  name: VirtualMachineName,
  tool: TrimmedNonEmptyString,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export type VirtualMachineControlInput = typeof VirtualMachineControlInput.Type;

export const VirtualMachineUploadInput = Schema.Struct({
  name: VirtualMachineName,
  relativePath: TrimmedNonEmptyString,
  guestPath: TrimmedNonEmptyString.check(Schema.isPattern(/^\//)),
});
export type VirtualMachineUploadInput = typeof VirtualMachineUploadInput.Type;

export const VirtualMachineDownloadInput = Schema.Struct({
  name: VirtualMachineName,
  guestPath: GuestPath,
  relativePath: TrimmedNonEmptyString,
});
export type VirtualMachineDownloadInput = typeof VirtualMachineDownloadInput.Type;

export const VirtualMachineToolsInput = Schema.Struct({
  name: VirtualMachineName,
  tools: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({
      description:
        "Tool names to return with their full JSON schemas. Omit to list every tool's name and description only.",
    }),
  ),
});
export type VirtualMachineToolsInput = typeof VirtualMachineToolsInput.Type;

export const VirtualMachineScreenshot = Schema.Struct({
  name: VirtualMachineName,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
  }),
});
export type VirtualMachineScreenshot = typeof VirtualMachineScreenshot.Type;

export class VirtualMachineError extends Schema.TaggedError<VirtualMachineError>()(
  "VirtualMachineError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "disabled",
      "unavailable",
      "not-found",
      "not-open",
      "busy",
      "source-running",
      "shared",
      "already-exists",
      "command-failed",
      "invalid-response",
      "storage",
    ]),
    command: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
    exitCode: Schema.optional(Schema.Int),
    failure: Schema.optional(
      Schema.Literals([
        "network-gateway",
        "disk-space",
        "vm-limit",
        "image-download",
        "local-service",
        "permission",
        "timeout",
        "spawn",
        "output-limit",
        "read",
        "command-exit",
      ]),
    ),
    diagnosticId: Schema.optional(Schema.String.check(Schema.isMaxLength(32))),
    // Running macOS VMs on the host when a start hit Apple's limit of two.
    runningMachines: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(8)),
    ),
    // Threads other than the caller's that hold the VM open.
    otherThreads: Schema.optional(Schema.Int),
    // Why a session this thread once held is gone.
    closedBy: Schema.optional(Schema.Literals(["close", "suspend", "delete", "disable"])),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "Enable virtual machines in the Virtual machine panel first.";
      case "unavailable":
        return "Virtual machines require an Apple silicon Mac with Lume and Cua installed.";
      case "not-found":
        switch (this.operation) {
          case "job":
            return "No background job with this id exists in this VM. Jobs are lost when the VM is deleted.";
          case "upload":
            return "relativePath must name a file inside this thread's workspace, and any symlink must point inside it too.";
          case "download":
            return "relativePath must stay inside this thread's workspace, in a directory that exists, and must not name a symlink or a directory.";
          default:
            return "This virtual machine was not found. Refresh the VM list.";
        }
      case "not-open":
        switch (this.closedBy) {
          case "suspend":
            return "Someone suspended this virtual machine from the Device panel or another thread, and that ended every thread's session on it. Call device_open to resume it. Processes in the guest kept their state.";
          case "delete":
            return "This virtual machine was deleted. Call device_list for the machines that remain.";
          case "disable":
            return "Virtual machines were turned off for this environment, and that ended every session.";
          case "close":
            return "This thread's session on the virtual machine was closed. Call device_open again to keep using it.";
          default:
            return "Open this virtual machine in the thread before controlling it. Sessions are per thread and end when T3 Code restarts.";
        }
      case "busy":
        return "A virtual machine operation is already running.";
      case "source-running":
        return "Suspend the source VM before cloning it. A clone copies the source's disk, which must not change during the copy.";
      case "shared":
        return `${this.otherThreads ?? "Other"} other thread${this.otherThreads === 1 ? " has" : "s have"} this VM open, and suspending it would end their sessions. Call device_close without shutdown, or ask the user to suspend it from the Device panel.`;
      case "already-exists":
        return "A virtual machine with this name already exists. Choose a different name.";
      case "command-failed":
        if (this.operation === "desktop-startup")
          return "The macOS desktop is still starting. Open the VM again to reconnect.";
        if (this.command) {
          const explanations = {
            "network-gateway":
              "Cua could not locate its cua-netgw network gateway. Set CUA_NETGW to the matching helper on the VM host, or repair the Cua installation, then retry.",
            "disk-space":
              "Cua reported insufficient disk space. Free storage on the VM host, then retry.",
            "vm-limit":
              "macOS reported its running VM limit was reached. Suspend another VM on this host, then retry.",
            "image-download":
              "The macOS image could not be downloaded. Check the VM host's network connection and image registry access, then retry.",
            "local-service":
              "Cua could not reach its local VM service. Check the Cua and Lume services on the VM host, then retry.",
            permission:
              "The VM host denied access. Check Cua's permissions on that host, then retry.",
            timeout: "Cua exceeded the command's time limit. Check the VM host before retrying.",
            spawn:
              "The VM host could not launch Cua. Check its installation and executable permissions.",
            "output-limit": "Cua's response exceeded the command output limit.",
            read: "The VM host could not read Cua's response.",
            "command-exit": "Cua reported a command failure.",
          };
          const summary =
            this.operation === "create" ? "macOS setup failed" : "Virtual machine operation failed";
          const exit = this.exitCode === undefined ? "" : ` (exit ${this.exitCode})`;
          const explanation =
            this.failure === undefined
              ? "Cua reported a command failure."
              : this.failure === "vm-limit" && this.runningMachines?.length
                ? `Apple allows two running macOS VMs per Mac, and these are running: ${this.runningMachines.join(", ")}. Suspend one, or ask the user which may be stopped, then retry.`
                : explanations[this.failure];
          const reference = this.diagnosticId
            ? ` Open Diagnostics on the VM host and search its logs for Diagnostic ID: ${this.diagnosticId}.`
            : " Check the VM host's diagnostics and logs for the command output.";
          return `${summary}: ${this.command}${exit}. ${explanation}${reference}`;
        }
        if (this.operation === "create")
          return "The macOS setup command failed. Check the VM host's diagnostics and logs.";
        return `The virtual machine ${this.operation} command failed. Check the environment server logs.`;
      case "invalid-response":
        return "Cua returned an unsupported response. Update Cua and try again.";
      case "storage":
        return "Virtual machine settings could not be saved.";
    }
  }
}
