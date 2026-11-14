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
  cpu: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 16 })),
  memoryGb: Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: 64 })),
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

export const VirtualMachineExecInput = Schema.Struct({
  name: VirtualMachineName,
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(128_000)),
});
export type VirtualMachineExecInput = typeof VirtualMachineExecInput.Type;
export const VirtualMachineExecResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
});

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
        return "This virtual machine was not found. Refresh the VM list.";
      case "not-open":
        return "Open this virtual machine in the thread before controlling it.";
      case "busy":
        return "A virtual machine operation is already running.";
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
