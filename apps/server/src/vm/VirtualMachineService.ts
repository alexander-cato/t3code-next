import {
  VirtualMachineError,
  VirtualMachineName,
  type ThreadId,
  type VirtualMachineControlInput,
  type VirtualMachineCreateInput,
  type VirtualMachineDownloadInput,
  type VirtualMachineExecInput,
  type VirtualMachineExecResult,
  type VirtualMachineGuest,
  type VirtualMachineHostInventory,
  type VirtualMachineJobInput,
  type VirtualMachineJobResult,
  type VirtualMachineOpenInput,
  type VirtualMachineScreenshot,
  type VirtualMachineState,
  type VirtualMachineViewer,
  type VirtualMachineUploadInput,
} from "@t3tools/contracts";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { isCommandAvailable, resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Duration from "effect/Duration";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TxReentrantLock from "effect/TxReentrantLock";
import * as McpSchema from "effect/ai/McpSchema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { threadWorkspaceRoot } from "../project/threadWorkspaceRoot.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const CuaMachine = Schema.Struct({
  name: VirtualMachineName,
  status: Schema.String,
  location: Schema.String,
  runtime: Schema.NullOr(Schema.String),
});
const ExecReply = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  returncode: Schema.Number,
});
// Lume reports every VM in its store, including ones Cua and T3 did not create.
const LumeMachine = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  os: Schema.optional(Schema.NullOr(Schema.String)),
  cpuCount: Schema.optional(Schema.NullOr(Schema.Number)),
  memorySize: Schema.optional(Schema.NullOr(Schema.Number)),
});
// Apple's Virtualization framework runs at most two macOS guests per Mac.
const MACOS_GUEST_LIMIT = 2;
const ViewerLink = Schema.Struct({ url: Schema.String, expires_at_unix: Schema.Number });
const ViewerVncFallback = Schema.Struct({
  name: Schema.String,
  opened: Schema.Literal(false),
  url: Schema.String,
  via: Schema.Literal("vnc"),
  open_command: Schema.Array(Schema.String),
});
const ViewerReply = Schema.Union([ViewerLink, ViewerVncFallback]);
const McpConnection = Schema.Struct({
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
});
const isVirtualMachineError = Schema.is(VirtualMachineError);
const isMcpError = Schema.is(McpSchema.McpError);
const isProcessTimeoutError = Schema.is(ProcessRunner.ProcessTimeoutError);
const isProcessSpawnError = Schema.is(ProcessRunner.ProcessSpawnError);
const isProcessOutputLimitError = Schema.is(ProcessRunner.ProcessOutputLimitError);
const isEndedSession = Schema.is(Schema.Struct({ code: Schema.Literal("session_ended") }));
const isRevivedSession = Schema.is(Schema.Struct({ revived: Schema.Literal(true) }));
const GuestRpcs = RpcGroup.make(McpSchema.Initialize, McpSchema.CallTool, McpSchema.ListTools);
const Configuration = Schema.Struct({ enabled: Schema.Boolean });
const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(Configuration));

const commandFailure = (output: string): NonNullable<VirtualMachineError["failure"]> => {
  const text = NodeUtil.stripVTControlCharacters(output.slice(-64_000));
  if (/cua-netgw.{0,150}(?:not available|not found|missing)/i.test(text)) return "network-gateway";
  if (
    /no space left on device|not enough (?:free )?(?:disk |storage )?space|insufficient (?:disk |free )?space|ENOSPC/i.test(
      text,
    )
  )
    return "disk-space";
  if (
    /maximum (?:supported )?number of (?:supported |active )?virtual machines|number of virtual machines exceeds the limit|already runs \d+ macOS VMs|(?:running|concurrent) vm limit|virtual machine limit/i.test(
      text,
    )
  )
    return "vm-limit";
  if (
    /failed to (?:download|pull)|(?:download|pull).{0,100}(?:failed|timed out)|(?:ghcr\.io|registry).{0,120}(?:unauthorized|forbidden|connection|failed)/i.test(
      text,
    )
  )
    return "image-download";
  if (
    /failed to (?:connect|contact).{0,80}(?:lume|daemon|local service)|(?:lume|daemon).{0,100}(?:connection refused|not running|not reachable|unavailable)/i.test(
      text,
    )
  )
    return "local-service";
  if (/permission denied|operation not permitted|EACCES/i.test(text)) return "permission";
  return "command-exit";
};

// This image includes the guest service, desktop automation and development tools.
// A vanilla Lume install has SSH/VNC but cannot serve the embedded desktop viewer.
// Lume's pull API requires name:tag; Cua's dated tags are immutable.
const MACOS_IMAGE = "ghcr.io/trycua/macos:26-20261003-a7b1e34";
export const VM_VIEWER_PREFIX = "/api/vm-viewer";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const jobDirectory = (id: string) => `"$HOME/.t3-vm-jobs/${id}"`;

/** One guest command that reports what the guest can build and whether sudo needs a password. */
const GUEST_PROBE = [
  'echo "macos=$(sw_vers -productVersion)"',
  'echo "cpu=$(sysctl -n hw.ncpu)"',
  'echo "memory=$(sysctl -n hw.memsize)"',
  "echo \"diskFreeKb=$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR==2{print $4}')\"",
  'echo "user=$(id -un)"',
  // xcode-select points at CommandLineTools when no Xcode is installed; xcodebuild then fails.
  'echo "xcode=$(xcodebuild -version 2>/dev/null | head -1)"',
  'echo "swift=$(swift --version 2>/dev/null | head -1)"',
  'echo "brew=$(command -v brew || ls /opt/homebrew/bin/brew 2>/dev/null)"',
  'echo "sip=$(csrutil status 2>/dev/null)"',
  'echo "sudo=$(sudo -n true 2>/dev/null && echo yes)"',
].join("; ");

export const parseGuestProbe = (stdout: string): VirtualMachineGuest | null => {
  const facts = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) facts.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  const macos = facts.get("macos");
  if (!macos) return null;
  const number = (key: string, divisor: number) => {
    const value = Number(facts.get(key));
    return Number.isFinite(value) && value > 0 ? Math.round((value / divisor) * 10) / 10 : null;
  };
  const sip = facts.get("sip") ?? "";
  return {
    macos,
    cpu: number("cpu", 1),
    memoryGb: number("memory", 1024 ** 3),
    diskFreeGb: number("diskFreeKb", 1024 ** 2),
    user: facts.get("user") ?? "",
    xcode: facts.get("xcode") || null,
    swift: facts.get("swift") || null,
    homebrew: Boolean(facts.get("brew")),
    sipEnabled: /enabled/i.test(sip) ? true : /disabled/i.test(sip) ? false : null,
    passwordlessSudo: facts.get("sudo") === "yes",
  };
};

export class VirtualMachineService extends Context.Service<
  VirtualMachineService,
  {
    readonly state: Effect.Effect<VirtualMachineState>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<VirtualMachineState>, never, Scope.Scope>;
    readonly list: Effect.Effect<VirtualMachineState, VirtualMachineError>;
    readonly configure: (
      enabled: boolean,
    ) => Effect.Effect<VirtualMachineState, VirtualMachineError>;
    readonly create: (input: VirtualMachineCreateInput) => Effect.Effect<void, VirtualMachineError>;
    readonly open: (
      input: VirtualMachineOpenInput,
    ) => Effect.Effect<VirtualMachineViewer, VirtualMachineError>;
    readonly close: (input: VirtualMachineOpenInput) => Effect.Effect<void>;
    readonly stop: (name: string) => Effect.Effect<void, VirtualMachineError>;
    readonly remove: (name: string) => Effect.Effect<void, VirtualMachineError>;
    readonly dismiss: (name: string) => Effect.Effect<void, VirtualMachineError>;
    readonly exec: (
      threadId: ThreadId,
      input: VirtualMachineExecInput,
    ) => Effect.Effect<VirtualMachineExecResult, VirtualMachineError>;
    readonly job: (
      threadId: ThreadId,
      input: VirtualMachineJobInput,
    ) => Effect.Effect<VirtualMachineJobResult, VirtualMachineError>;
    /** What the guest can build. Probed once per power cycle; null when the probe cannot run. */
    readonly inspect: (
      threadId: ThreadId,
      name: string,
    ) => Effect.Effect<VirtualMachineGuest | null, VirtualMachineError>;
    readonly knownGuests: Effect.Effect<Readonly<Record<string, VirtualMachineGuest>>>;
    /** Every Lume VM on this Mac, so agents can see who holds the two macOS guest slots. */
    readonly hostInventory: Effect.Effect<VirtualMachineHostInventory, VirtualMachineError>;
    /** Names of the other threads' sessions on this VM. A suspend closes them all. */
    readonly otherSessions: (threadId: ThreadId, name: string) => Effect.Effect<number>;
    readonly control: (
      threadId: ThreadId,
      input: VirtualMachineControlInput,
    ) => Effect.Effect<McpSchema.CallToolResult, VirtualMachineError>;
    readonly tools: (
      threadId: ThreadId,
      name: string,
    ) => Effect.Effect<ReadonlyArray<McpSchema.Tool>, VirtualMachineError>;
    readonly screenshot: (
      threadId: ThreadId,
      name: string,
    ) => Effect.Effect<VirtualMachineScreenshot, VirtualMachineError>;
    readonly upload: (
      threadId: ThreadId,
      input: VirtualMachineUploadInput,
    ) => Effect.Effect<
      void,
      VirtualMachineError,
      ProjectService.ProjectService | ThreadManagementService.ThreadManagementService
    >;
    readonly download: (
      threadId: ThreadId,
      input: VirtualMachineDownloadInput,
    ) => Effect.Effect<
      { readonly bytes: number },
      VirtualMachineError,
      ProjectService.ProjectService | ThreadManagementService.ThreadManagementService
    >;
    readonly viewerLifetime: (leaseId: string) => Effect.Effect<void>;
    readonly viewerUpstream: (leaseId: string) => Effect.Effect<string | null>;
  }
>()("t3/vm/VirtualMachineService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const random = yield* SecureRandom.SecureRandom;
  const scope = yield* Scope.Scope;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const root = path.join(config.stateDir, "virtual-machines");
  const stateDir = path.join(root, "cua");
  const settingsPath = path.join(root, "settings.json");
  const saved = yield* fs.readFileString(settingsPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration))),
    Effect.orElseSucceed(() => ({ enabled: false })),
  );
  const state = yield* Ref.make<VirtualMachineState>({
    enabled: saved.enabled,
    available: false,
    unavailableReason: null,
    machines: [],
    sessions: [],
    closedSessions: [],
    operations: [],
  });
  let inventoryRevision = 0;
  let inventoryRequest = 0;
  let publishedInventoryRequest = 0;
  const changes = yield* PubSub.unbounded<VirtualMachineState>();
  const configurationLock = yield* TxReentrantLock.make();
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  const withKeyLock = <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
    permits: { readonly take: number; readonly total: number } = { take: 1, total: 1 },
  ) =>
    Effect.suspend(() => {
      const entry = locks.get(key) ?? {
        semaphore: Semaphore.makeUnsafe(permits.total),
        users: 0,
      };
      locks.set(key, entry);
      entry.users++;
      return entry.semaphore
        .withPermits(permits.take)(effect)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (--entry.users === 0) locks.delete(key);
            }),
          ),
        );
    });
  // Guest calls share a VM; suspend and delete take every permit and run alone.
  // A thread/VM pair serializes its MCP transport and session changes.
  // Disabling waits for these calls before revoking their sessions.
  const MACHINE_PERMITS = 1024;
  const withMachine = <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
    options: { readonly threadId?: ThreadId; readonly exclusive?: boolean } = {},
  ) =>
    TxReentrantLock.withReadLock(
      configurationLock,
      withKeyLock(
        `machine:${name}`,
        options.threadId
          ? withKeyLock(`${options.threadId.length}:${options.threadId}:${name}`, effect)
          : effect,
        { take: options.exclusive ? MACHINE_PERMITS : 1, total: MACHINE_PERMITS },
      ),
    );
  const http = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient);
  const guestConnections = new Map<
    string,
    {
      name: string;
      threadId: ThreadId;
      client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof GuestRpcs>, RpcClientError>;
      scope: Scope.Closeable;
      cursorSessions: Set<string | undefined>;
    }
  >();
  const leases = new Map<
    string,
    { name: string; threadId: ThreadId; origin: string; expiresAt: number }
  >();
  type ClosedBy = NonNullable<VirtualMachineError["closedBy"]>;
  // Why a thread lost its session, so its next tool call can say so. Cleared on reopen.
  const closures = new Map<string, ClosedBy>();
  const sessionKey = (threadId: ThreadId, name: string) => `${threadId.length}:${threadId}:${name}`;
  const recordClosures = (
    sessions: ReadonlyArray<{ readonly name: string; readonly threadId: ThreadId }>,
    closedBy: ClosedBy,
  ) => {
    for (const session of sessions) {
      const key = sessionKey(session.threadId, session.name);
      closures.delete(key);
      closures.set(key, closedBy);
    }
    while (closures.size > 256) closures.delete(closures.keys().next().value!);
  };
  const guests = new Map<string, VirtualMachineGuest>();

  const publish = Effect.fn("VirtualMachineService.publish")(function* (
    update: (value: VirtualMachineState) => VirtualMachineState,
  ) {
    const [previous, next] = yield* Ref.modify(state, (value) => {
      const updated = update(value);
      return [[value, updated] as const, updated];
    });
    // Every subscribed client receives the whole state, so unchanged updates are dropped.
    if (next !== previous) yield* PubSub.publish(changes, next);
    return next;
  });

  const childEnvironment = Effect.fn("VirtualMachineService.childEnvironment")(
    function* () {
      if (environment.CUA_NETGW !== undefined) return undefined;
      const executable = yield* resolveCommandPath("cua", { env: environment });
      if (!executable) return undefined;
      // Cua's macOS sibling lookup retains launcher symlinks, hiding the bundled gateway.
      const real = yield* fs.realPath(executable).pipe(Effect.orElseSucceed(() => null));
      if (!real) return undefined;
      const gateway = path.join(path.dirname(real), "cua-netgw");
      if (!(yield* isCommandAvailable(gateway, { env: environment }))) return undefined;
      return { ...environment, CUA_NETGW: gateway };
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
  const failCommand = Effect.fn("VirtualMachineService.failCommand")(function* (
    operation: string,
    args: ReadonlyArray<string>,
    cause: ProcessRunner.ProcessRunError | ProcessRunner.ProcessRunOutput,
  ) {
    const result = "stdout" in cause ? cause : undefined;
    const failure = result
      ? result.timedOut
        ? "timeout"
        : commandFailure(`${result.stderr.slice(-32_000)}\n${result.stdout.slice(-32_000)}`)
      : isProcessTimeoutError(cause)
        ? "timeout"
        : isProcessSpawnError(cause)
          ? "spawn"
          : isProcessOutputLimitError(cause)
            ? "output-limit"
            : "read";
    const command =
      args[0] === "sandbox" &&
      [
        "create",
        "ls",
        "resume",
        "suspend",
        "rm",
        "view",
        "mcp",
        "exec",
        "cp",
        "screenshot",
      ].includes(args[1] ?? "")
        ? `cua sandbox ${args[1]}`
        : operation === "inventory"
          ? "lume ls"
          : "cua";
    const diagnosticId = `vm-${(yield* random.uuidV4().pipe(Effect.orDie)).replaceAll("-", "").slice(0, 12)}`;
    const details = {
      operation,
      reason: "command-failed" as const,
      command,
      failure,
      exitCode: result?.code ?? undefined,
      diagnosticId,
    };
    yield* Effect.logWarning(
      "Virtual machine command failed",
      new VirtualMachineError({ ...details, cause }),
    );
    return yield* new VirtualMachineError(details);
  });
  const run = Effect.fn("VirtualMachineService.run")(function* (
    operation: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly timeout?: Duration.Input;
      readonly allowFailure?: boolean;
    },
  ) {
    const result = yield* runner
      .run({
        command: "cua",
        args: ["--embedded", "--state-dir", stateDir, "--json", ...args],
        env: yield* childEnvironment(),
        timeout: options?.timeout ?? "60 seconds",
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(Effect.catch((cause) => failCommand(operation, args, cause)));
    if (result.code !== 0 && !options?.allowFailure) {
      return yield* failCommand(operation, args, result);
    }
    if (["create", "start", "stop", "delete"].includes(operation)) inventoryRevision++;
    return result;
  });
  const decode = <S extends Schema.Top>(schema: S, value: string) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.mapError(
        (cause) =>
          new VirtualMachineError({ operation: "decode", reason: "invalid-response", cause }),
      ),
    );
  const disconnectGuest = Effect.fn("VirtualMachineService.disconnectGuest")(function* (
    name?: string,
    threadId?: ThreadId,
  ) {
    for (const [id, connection] of guestConnections) {
      if (
        (name === undefined || connection.name === name) &&
        (threadId === undefined || connection.threadId === threadId)
      ) {
        guestConnections.delete(id);
        yield* Scope.close(connection.scope, Exit.void);
      }
    }
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      leases.clear();
      yield* disconnectGuest();
      yield* publish((value) => ({ ...value, sessions: [] }));
    }),
  );
  const guestClient = Effect.fn("VirtualMachineService.guestClient")(function* (
    threadId: ThreadId,
    name: string,
  ) {
    const key = `${threadId.length}:${threadId}:${name}`;
    const existing = guestConnections.get(key);
    if (existing) return existing;
    const connection = yield* run("connect", [
      "sandbox",
      "mcp",
      `local:${name}`,
      "env",
      "config",
      "--show-secrets",
    ]);
    const settings = yield* decode(McpConnection, connection.stdout);
    const connectionScope = yield* Scope.fork(scope, "sequential");
    // Cua ends lifecycle sessions and invalidates AX tokens when an MCP transport
    // closes. Keep its negotiated transport ID private and reuse it for this thread and VM.
    let sessionId: string | undefined;
    const client = http.pipe(
      HttpClient.mapRequest((request) =>
        HttpClientRequest.setHeaders(request, {
          ...settings.headers,
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        }),
      ),
      HttpClient.transformResponse(
        Effect.tap((response) =>
          Effect.sync(() => {
            sessionId = response.headers["mcp-session-id"] ?? sessionId;
          }),
        ),
      ),
      HttpClient.filterStatusOk,
    );
    const connect = Effect.gen(function* () {
      // Effect's RPC tracing fields are outside MCP's strict JSON-RPC envelope.
      const rpc = yield* RpcClient.make(GuestRpcs, { disableTracing: true }).pipe(
        Effect.provide(
          // Prefixing an empty RPC path adds a slash; Cua requires exactly /mcp.
          RpcClient.layerProtocolHttp({
            url: "",
            transformClient: (httpClient) =>
              HttpClient.mapRequest(httpClient, HttpClientRequest.setUrl(settings.url)),
          }).pipe(
            Layer.provide(RpcSerialization.layerJsonRpc()),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
      );
      yield* Effect.addFinalizer(() =>
        sessionId
          ? client.del(settings.url).pipe(Effect.timeout("5 seconds"), Effect.ignore)
          : Effect.void,
      );
      const initialized = yield* rpc.initialize({
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t3-code", version: "1" },
      });
      if (initialized.protocolVersion !== "2025-06-18" || !sessionId) {
        return yield* new VirtualMachineError({ operation: "connect", reason: "invalid-response" });
      }
      yield* client.post(settings.url, {
        body: HttpBody.jsonUnsafe({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      return rpc;
    }).pipe(
      Effect.provideService(Scope.Scope, connectionScope),
      Effect.timeout("60 seconds"),
      Effect.onError(() => Scope.close(connectionScope, Exit.void)),
      Effect.mapError((cause) =>
        isVirtualMachineError(cause)
          ? cause
          : new VirtualMachineError({ operation: "connect", reason: "command-failed", cause }),
      ),
    );
    const rpc = yield* connect;
    const established = {
      name,
      threadId,
      client: rpc,
      scope: connectionScope,
      cursorSessions: new Set<string | undefined>(),
    };
    guestConnections.set(key, established);
    return established;
  });
  const requireEnabled = Effect.fn("VirtualMachineService.requireEnabled")(function* () {
    if (!(yield* Ref.get(state)).enabled)
      return yield* new VirtualMachineError({ operation: "access", reason: "disabled" });
    if (platform !== "darwin" || arch !== "arm64")
      return yield* new VirtualMachineError({ operation: "access", reason: "unavailable" });
  });
  const list = Effect.fn("VirtualMachineService.list")(function* () {
    const request = ++inventoryRequest;
    const revision = inventoryRevision;
    const available =
      platform === "darwin" &&
      arch === "arm64" &&
      (yield* isCommandAvailable("lume", { env: environment }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      )) &&
      (yield* isCommandAvailable("cua", { env: environment }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ));
    const unavailableReason = available
      ? null
      : "Local macOS VMs need an Apple silicon Mac with Lume and Cua 0.4 or later installed.";
    const before = yield* publish((value) =>
      value.available === available && value.unavailableReason === unavailableReason
        ? value
        : { ...value, available, unavailableReason },
    );
    if (!before.enabled || !available) return before;
    const result = yield* run("list", ["sandbox", "ls", "--local", "--no-size"]);
    const machines = (yield* decode(Schema.Array(CuaMachine), result.stdout))
      .filter((machine) => machine.location === "local" && machine.runtime === "lume")
      .map(({ name, status }) => ({ name, status }));
    return yield* publish((value) => {
      if (revision !== inventoryRevision || request < publishedInventoryRequest) return value;
      publishedInventoryRequest = request;
      const unchanged =
        value.machines.length === machines.length &&
        value.machines.every(
          (machine, index) =>
            machine.name === machines[index]!.name && machine.status === machines[index]!.status,
        );
      return unchanged ? value : { ...value, machines };
    });
  });
  const requireMachine = Effect.fn("VirtualMachineService.requireMachine")(function* (
    name: string,
  ) {
    yield* requireEnabled();
    const current = yield* list();
    const machine = current.machines.find((entry) => entry.name === name);
    if (!machine)
      return yield* new VirtualMachineError({ operation: "lookup", reason: "not-found" });
    return machine;
  });
  const requireOpen = Effect.fn("VirtualMachineService.requireOpen")(function* (
    threadId: ThreadId,
    name: string,
  ) {
    yield* requireEnabled();
    if (
      !(yield* Ref.get(state)).sessions.some(
        (session) => session.name === name && session.threadId === threadId,
      )
    ) {
      const closedBy = closures.get(sessionKey(threadId, name));
      return yield* new VirtualMachineError({
        operation: "control",
        reason: "not-open",
        ...(closedBy === undefined ? {} : { closedBy }),
      });
    }
  });
  const forget = Effect.fn("VirtualMachineService.forget")(function* (
    name: string,
    threadId: ThreadId | undefined,
    closedBy: ClosedBy,
  ) {
    const id = yield* random.uuidV4().pipe(Effect.orDie);
    recordClosures(
      (yield* Ref.get(state)).sessions.filter(
        (session) =>
          session.name === name && (threadId === undefined || session.threadId === threadId),
      ),
      closedBy,
    );
    yield* disconnectGuest(name, threadId);
    for (const [id, lease] of leases)
      if (lease.name === name && (threadId === undefined || lease.threadId === threadId))
        leases.delete(id);
    yield* publish((value) => {
      const closing =
        threadId === undefined
          ? value.sessions.filter((session) => session.name === name)
          : [{ name, threadId }];
      return {
        ...value,
        closedSessions: [
          ...(value.closedSessions ?? []).filter(
            (session) =>
              !closing.some(
                (entry) => entry.name === session.name && entry.threadId === session.threadId,
              ),
          ),
          ...closing.map((session) => ({ ...session, id })),
        ],
        sessions: value.sessions.filter(
          (session) =>
            session.name !== name || (threadId !== undefined && session.threadId !== threadId),
        ),
      };
    });
  });
  const configure = Effect.fn("VirtualMachineService.configure")(function* (enabled: boolean) {
    if (
      !enabled &&
      (yield* Ref.get(state)).operations.some((operation) => operation.status === "creating")
    ) {
      return yield* new VirtualMachineError({ operation: "configure", reason: "busy" });
    }
    yield* fs
      .makeDirectory(root, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new VirtualMachineError({ operation: "configure", reason: "storage", cause }),
        ),
      );
    yield* writeFileStringAtomically({
      filePath: settingsPath,
      contents: yield* encodeConfiguration({ enabled }).pipe(Effect.orDie),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) => new VirtualMachineError({ operation: "configure", reason: "storage", cause }),
      ),
    );
    if (!enabled) {
      leases.clear();
      recordClosures((yield* Ref.get(state)).sessions, "disable");
      yield* disconnectGuest();
    }
    yield* publish((value) => ({ ...value, enabled, sessions: enabled ? value.sessions : [] }));
    return yield* list();
  });
  const hostInventory = Effect.fn("VirtualMachineService.hostInventory")(function* () {
    yield* requireEnabled();
    const managed = new Set((yield* Ref.get(state)).machines.map((machine) => machine.name));
    const args = ["ls", "--format", "json"];
    const result = yield* runner
      .run({ command: "lume", args, timeout: "30 seconds", maxOutputBytes: 1024 * 1024 })
      .pipe(Effect.catch((cause) => failCommand("inventory", args, cause)));
    if (result.code !== 0) return yield* failCommand("inventory", args, result);
    // Lume can print a timestamped log line ahead of its JSON.
    const machines = yield* decode(
      Schema.Array(LumeMachine),
      result.stdout.replace(/^\[\d{4}-\d\d-\d\dT[^\n]*\n?/gm, ""),
    );
    return {
      runningLimit: MACOS_GUEST_LIMIT,
      machines: machines
        .filter((machine) => (machine.os ?? "macOS").toLowerCase() === "macos")
        .map((machine) => ({
          name: machine.name,
          status: machine.status,
          cpu: machine.cpuCount ?? null,
          memoryGb:
            machine.memorySize == null
              ? null
              : Math.round((machine.memorySize / 1024 ** 3) * 10) / 10,
          managed: managed.has(machine.name),
        })),
    };
  });
  const createArgs = (input: VirtualMachineCreateInput) => [
    "sandbox",
    "create",
    MACOS_IMAGE,
    "--on",
    "local",
    "--kind",
    "vm",
    "--runtime",
    "lume",
    "--name",
    input.name,
    "--cpu",
    String(input.cpu),
    "--memory",
    `${input.memoryGb}GB`,
    "--wait",
    "desktop",
  ];
  // Apple's limit counts every macOS guest on the Mac, so name the ones holding the slots.
  const withSlotHolders = <A, R>(effect: Effect.Effect<A, VirtualMachineError, R>) =>
    effect.pipe(
      Effect.catchIf(
        (error) => error.failure === "vm-limit",
        (error) =>
          hostInventory().pipe(
            Effect.map((host) =>
              host.machines
                .filter((machine) => !["stopped", "suspended"].includes(machine.status))
                .map((machine) => machine.name)
                .slice(0, 8),
            ),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
            Effect.flatMap((runningMachines) =>
              Effect.fail(
                runningMachines.length === 0
                  ? error
                  : new VirtualMachineError({
                      operation: error.operation,
                      reason: error.reason,
                      command: error.command,
                      exitCode: error.exitCode,
                      failure: error.failure,
                      diagnosticId: error.diagnosticId,
                      runningMachines,
                    }),
              ),
            ),
          ),
      ),
    );
  const create = Effect.fn("VirtualMachineService.create")(function* (
    input: VirtualMachineCreateInput,
  ) {
    yield* requireEnabled();
    const current = yield* list();
    if (!current.available)
      return yield* new VirtualMachineError({ operation: "create", reason: "unavailable" });
    if (current.machines.some((machine) => machine.name === input.name))
      return yield* new VirtualMachineError({ operation: "create", reason: "already-exists" });
    if (current.operations.some((operation) => operation.status === "creating")) {
      return yield* new VirtualMachineError({ operation: "create", reason: "busy" });
    }
    if (input.from !== undefined) {
      const source = current.machines.find((machine) => machine.name === input.from);
      if (!source)
        return yield* new VirtualMachineError({ operation: "create", reason: "not-found" });
      if (source.status !== "stopped")
        return yield* new VirtualMachineError({ operation: "create", reason: "source-running" });
    }
    yield* publish((value) => ({
      ...value,
      operations: [
        ...value.operations.filter((operation) => operation.name !== input.name),
        { name: input.name, status: "creating", error: null },
      ],
    }));
    // A fork restores the source's saved memory, so a clone of a suspended VM resumes its desktop.
    const command =
      input.from === undefined
        ? run("create", createArgs(input), { timeout: "60 minutes" })
        : run("create", ["sandbox", "fork", `local:${input.from}`, input.name], {
            timeout: "10 minutes",
          });
    yield* withSlotHolders(command).pipe(
      Effect.andThen(() =>
        list().pipe(
          // Provisioning reached the desktop. A failed refresh must not offer creation again.
          Effect.catch(() =>
            publish((value) => ({
              ...value,
              machines: [
                ...value.machines.filter((machine) => machine.name !== input.name),
                { name: input.name, status: "ready" },
              ],
            })),
          ),
        ),
      ),
      Effect.andThen(
        publish((value) => ({
          ...value,
          operations: value.operations.filter((operation) => operation.name !== input.name),
        })),
      ),
      Effect.catch((error) =>
        publish((value) => ({
          ...value,
          operations: value.operations.map((operation) =>
            operation.name === input.name
              ? { ...operation, status: "failed", error: error.message }
              : operation,
          ),
        })),
      ),
      Effect.forkIn(scope),
    );
  });

  const requestViewer = Effect.fn("VirtualMachineService.requestViewer")(function* (name: string) {
    const result = yield* run("viewer", [
      "sandbox",
      "view",
      `local:${name}`,
      "--no-open",
      "--ttl",
      "1h",
    ]);
    const link = yield* decode(ViewerReply, result.stdout);
    const url = yield* Effect.try({
      try: () => new URL(link.url),
      catch: (cause) =>
        new VirtualMachineError({ operation: "viewer", reason: "invalid-response", cause }),
    });
    // Cua falls back to host VNC while cua-spacesd boots. Never run open_command.
    if ("via" in link) {
      if (link.name !== `local:${name}` || url.protocol !== "vnc:" || !url.hostname)
        return yield* new VirtualMachineError({ operation: "viewer", reason: "invalid-response" });
      return null;
    }
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      !url.pathname.endsWith("/viewer/") ||
      !new URLSearchParams(url.hash.slice(1)).get("ticket")
    )
      return yield* new VirtualMachineError({ operation: "viewer", reason: "invalid-response" });
    return { link, url };
  });
  const open = Effect.fn("VirtualMachineService.open")(function* (input: VirtualMachineOpenInput) {
    yield* requireMachine(input.name);
    // Cua's saved ready status survives host restarts. Resume checks Lume and
    // leaves an already running guest and its control sessions intact.
    // Opens from other threads share the VM, but only one may start it.
    yield* withKeyLock(
      `start:${input.name}`,
      withSlotHolders(
        run("start", ["sandbox", "resume", `local:${input.name}`], { timeout: "5 minutes" }),
      ),
    );
    const viewer = yield* requestViewer(input.name).pipe(
      Effect.repeat({ schedule: Schedule.spaced("2 seconds"), while: (reply) => reply === null }),
      Effect.timeoutOrElse({
        duration: "2 minutes",
        orElse: () =>
          Effect.fail(
            new VirtualMachineError({
              operation: "desktop-startup",
              reason: "command-failed",
            }),
          ),
      }),
    );
    if (viewer === null)
      return yield* new VirtualMachineError({ operation: "viewer", reason: "invalid-response" });
    const { link, url } = viewer;
    const id = yield* random.uuidV4().pipe(Effect.orDie);
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = Math.min(link.expires_at_unix * 1000, now + 3_600_000);
    for (const [key, lease] of leases) if (lease.expiresAt <= now) leases.delete(key);
    if (leases.size >= 64) leases.delete(leases.keys().next().value!);
    // A lease is issued only by the operate-scoped open RPC. Its guest viewer
    // ticket authorizes input and files without exposing the guest's root token.
    // This also works for remote clients whose environment auth uses DPoP.
    leases.set(id, {
      name: input.name,
      threadId: input.threadId,
      origin: new URL("../", url).toString(),
      expiresAt,
    });
    closures.delete(sessionKey(input.threadId, input.name));
    yield* publish((value) => ({
      ...value,
      machines: value.machines.map((machine) =>
        machine.name === input.name ? { ...machine, status: "ready" } : machine,
      ),
      sessions: [
        ...value.sessions.filter(
          (session) => session.threadId !== input.threadId || session.name !== input.name,
        ),
        { name: input.name, threadId: input.threadId },
      ],
      closedSessions: (value.closedSessions ?? []).filter(
        (session) => session.threadId !== input.threadId || session.name !== input.name,
      ),
    }));
    return {
      name: input.name,
      viewerPath: `${VM_VIEWER_PREFIX}/${id}/viewer/${url.hash}`,
      expiresInMs: expiresAt - now,
    };
  });
  const changePower = Effect.fn("VirtualMachineService.changePower")(function* (
    name: string,
    remove: boolean,
  ) {
    yield* requireMachine(name);
    yield* disconnectGuest(name);
    yield* run(
      remove ? "delete" : "stop",
      ["sandbox", remove ? "rm" : "suspend", `local:${name}`, ...(remove ? ["--force"] : [])],
      { timeout: "5 minutes" },
    );
    yield* forget(name, undefined, remove ? "delete" : "suspend");
    // An Xcode install survives a suspend, so only a deleted guest is probed again.
    if (remove) guests.delete(name);
    yield* publish((value) => ({
      ...value,
      machines: remove
        ? value.machines.filter((machine) => machine.name !== name)
        : value.machines.map((machine) =>
            machine.name === name ? { ...machine, status: "stopped" } : machine,
          ),
    }));
    // The power command succeeded; an inventory failure must not report it as failed.
    yield* list().pipe(Effect.ignore);
  });
  const screenshot = Effect.fn("VirtualMachineService.screenshot")(function* (
    threadId: ThreadId,
    name: string,
  ) {
    yield* requireOpen(threadId, name);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const temp = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-vm-screen-" })
          .pipe(
            Effect.mapError(
              (cause) =>
                new VirtualMachineError({ operation: "screenshot", reason: "storage", cause }),
            ),
          );
        const output = path.join(temp, "screen.png");
        yield* run("screenshot", ["sandbox", "screenshot", `local:${name}`, "--output", output]);
        const data = yield* fs
          .readFile(output)
          .pipe(
            Effect.mapError(
              (cause) =>
                new VirtualMachineError({ operation: "screenshot", reason: "storage", cause }),
            ),
          );
        const png = Buffer.from(data);
        if (
          png.length < 24 ||
          png.length > 16 * 1024 * 1024 ||
          png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        )
          return yield* new VirtualMachineError({
            operation: "screenshot",
            reason: "invalid-response",
          });
        return {
          name,
          screenshot: {
            mimeType: "image/png" as const,
            data: png.toString("base64"),
            width: png.readUInt32BE(16),
            height: png.readUInt32BE(20),
          },
        };
      }),
    );
  });
  const startJobScript = (jobId: string, command: string, cwd: string | undefined) => {
    const directory = jobDirectory(jobId);
    // The command goes through a file, so the guest shell never re-parses its quoting.
    // HUP is ignored because the exec that starts the job ends at once. The exit code
    // is renamed into place so a reader never sees a half-written file.
    return [
      `d=${directory}; mkdir -p "$d" || exit 1`,
      `printf '%s\\n' ${shellQuote(command)} > "$d/command"`,
      `( trap '' HUP; { ${cwd ? `cd ${shellQuote(cwd)} && ` : ""}sh "$d/command"; } > "$d/log" 2>&1 < /dev/null; echo $? > "$d/exit.tmp"; mv "$d/exit.tmp" "$d/exit" ) > /dev/null 2>&1 &`,
      `echo $! > "$d/pid"; echo "$d/log"`,
    ].join("\n");
  };
  const readJobScript = (jobId: string, tailBytes: number, stop: boolean) =>
    [
      `d=${jobDirectory(jobId)}; [ -d "$d" ] || { echo "T3JOB missing"; exit 0; }`,
      `p=$(cat "$d/pid" 2>/dev/null)`,
      // Stopping ends the command's whole process tree, deepest first, and leaves the
      // wrapper alive to record the exit code.
      ...(stop
        ? [
            `tree() { for c in $(pgrep -P "$1"); do tree "$c"; done; kill -TERM "$1" 2>/dev/null; }`,
            `if [ ! -f "$d/exit" ] && [ -n "$p" ]; then for c in $(pgrep -P "$p"); do tree "$c"; done; i=0; while [ ! -f "$d/exit" ] && [ $i -lt 10 ]; do sleep 0.5; i=$((i+1)); done; [ -f "$d/exit" ] || echo 143 > "$d/exit"; fi`,
          ]
        : []),
      `if [ -f "$d/exit" ]; then echo "T3JOB exited $(cat "$d/exit")"; elif [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "T3JOB running"; else echo "T3JOB lost"; fi`,
      `echo "$d/log"; tail -c ${tailBytes} "$d/log" 2>/dev/null`,
    ].join("\n");
  const guestShell = Effect.fn("VirtualMachineService.guestShell")(function* (
    name: string,
    command: string,
    timeoutSeconds: number,
    cwd?: string,
  ) {
    // The command is one argv element after `--`, so a leading hyphen is never a Cua option.
    // Cua executes it in the guest shell; the server never interpolates it into a host shell.
    // Cua's own default limit is shorter than ours, so the limit is always passed.
    const result = yield* run(
      "exec",
      [
        "sandbox",
        "exec",
        `local:${name}`,
        "--timeout",
        String(timeoutSeconds),
        ...(cwd ? ["--cwd", cwd] : []),
        "--",
        command,
      ],
      { allowFailure: true, timeout: `${timeoutSeconds + 30} seconds` },
    );
    return yield* decode(ExecReply, result.stdout);
  });
  /** Resolves a workspace-relative path and refuses one that leaves the workspace. */
  const workspacePath = Effect.fn("VirtualMachineService.workspacePath")(function* (
    operation: string,
    threadId: ThreadId,
    relativePath: string,
    target: "existing-file" | "new-file",
  ) {
    const storage = (cause: unknown) =>
      new VirtualMachineError({ operation, reason: "storage", cause });
    const outside = new VirtualMachineError({ operation, reason: "not-found" });
    const workspace = yield* threadWorkspaceRoot(threadId);
    if (!workspace || path.isAbsolute(relativePath)) return yield* outside;
    const rootPath = yield* fs.realPath(workspace).pipe(Effect.mapError(storage));
    const requested = path.resolve(rootPath, relativePath);
    // A new file has no real path yet; its directory must exist and stay inside the workspace.
    const resolved =
      target === "existing-file"
        ? yield* fs.realPath(requested).pipe(Effect.mapError(storage))
        : path.join(
            yield* fs.realPath(path.dirname(requested)).pipe(Effect.mapError(storage)),
            path.basename(requested),
          );
    const relative = path.relative(rootPath, resolved);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return yield* outside;
    const stat = yield* fs.stat(resolved).pipe(
      Effect.map((info) => info.type),
      Effect.catch((cause) =>
        target === "new-file" && cause.reason._tag === "NotFound"
          ? Effect.succeed("Missing" as const)
          : Effect.fail(storage(cause)),
      ),
    );
    // Replacing a regular file is allowed; a symlink already there could point anywhere.
    if (target === "new-file" && stat !== "Missing") {
      const link = yield* fs.readLink(resolved).pipe(Effect.option);
      if (link._tag === "Some" || stat !== "File") return yield* outside;
    }
    if (target === "existing-file" && stat !== "File") return yield* outside;
    return resolved;
  });
  return VirtualMachineService.of({
    state: Ref.get(state),
    subscribe: PubSub.subscribe(changes),
    list: list(),
    // Lock wrappers keep the named operation spans without adding another span.
    configure: Effect.fnUntraced(function* (enabled) {
      return yield* TxReentrantLock.withWriteLock(configurationLock, configure(enabled));
    }),
    create: Effect.fnUntraced(function* (input) {
      return yield* TxReentrantLock.withWriteLock(configurationLock, create(input));
    }),
    open: Effect.fnUntraced(function* (input) {
      return yield* withMachine(input.name, open(input), { threadId: input.threadId });
    }),
    close: Effect.fnUntraced(function* (input) {
      yield* withMachine(input.name, forget(input.name, input.threadId, "close"), {
        threadId: input.threadId,
      });
    }),
    stop: Effect.fnUntraced(function* (name) {
      yield* withMachine(name, changePower(name, false), { exclusive: true });
    }),
    remove: Effect.fnUntraced(function* (name) {
      yield* withMachine(name, changePower(name, true), { exclusive: true });
    }),
    dismiss: Effect.fn("VirtualMachineService.dismiss")(function* (name) {
      yield* requireEnabled();
      if (
        (yield* Ref.get(state)).operations.some(
          (entry) => entry.name === name && entry.status === "creating",
        )
      )
        return yield* new VirtualMachineError({ operation: "dismiss", reason: "busy" });
      yield* publish((value) => ({
        ...value,
        operations: value.operations.filter((entry) => entry.name !== name),
      }));
    }),
    exec: Effect.fn("VirtualMachineService.exec")(
      function* (threadId, input) {
        yield* requireOpen(threadId, input.name);
        if (input.background) {
          const jobId = (yield* random.uuidV4().pipe(Effect.orDie))
            .replaceAll("-", "")
            .slice(0, 12);
          const reply = yield* guestShell(
            input.name,
            startJobScript(jobId, input.command, input.cwd),
            60,
          );
          const logPath = reply.stdout.trim();
          if (reply.returncode !== 0 || !logPath.startsWith("/"))
            return yield* new VirtualMachineError({
              operation: "exec",
              reason: "invalid-response",
            });
          return { jobId, logPath };
        }
        const reply = yield* guestShell(
          input.name,
          input.command,
          input.timeoutSeconds ?? 300,
          input.cwd,
        );
        return { stdout: reply.stdout, stderr: reply.stderr, exitCode: reply.returncode };
      },
      (effect, _threadId, input) => withMachine(input.name, effect),
    ),
    job: Effect.fn("VirtualMachineService.job")(
      function* (threadId, input) {
        yield* requireOpen(threadId, input.name);
        const reply = yield* guestShell(
          input.name,
          readJobScript(input.jobId, input.tailBytes ?? 16_000, input.stop ?? false),
          60,
        );
        const [status = "", logPath = "", ...output] = reply.stdout.split("\n");
        const [marker, state, code] = status.split(" ");
        if (marker !== "T3JOB" || state === "missing")
          return yield* new VirtualMachineError({ operation: "job", reason: "not-found" });
        if (state !== "running" && state !== "exited" && state !== "lost")
          return yield* new VirtualMachineError({ operation: "job", reason: "invalid-response" });
        return {
          state,
          exitCode: state === "exited" && /^\d+$/.test(code ?? "") ? Number(code) : null,
          output: output.join("\n"),
          logPath,
        };
      },
      (effect, _threadId, input) => withMachine(input.name, effect),
    ),
    inspect: Effect.fn("VirtualMachineService.inspect")(
      function* (threadId, name) {
        yield* requireOpen(threadId, name);
        const known = guests.get(name);
        if (known) return known;
        const guest = parseGuestProbe((yield* guestShell(name, GUEST_PROBE, 30)).stdout);
        if (guest) guests.set(name, guest);
        return guest;
      },
      (effect, _threadId, name) => withMachine(name, effect),
    ),
    knownGuests: Effect.sync(() => Object.fromEntries(guests)),
    hostInventory: hostInventory(),
    otherSessions: Effect.fn("VirtualMachineService.otherSessions")(function* (threadId, name) {
      return (yield* Ref.get(state)).sessions.filter(
        (session) => session.name === name && session.threadId !== threadId,
      ).length;
    }),
    control: Effect.fn("VirtualMachineService.control")(
      function* (threadId, input) {
        yield* requireOpen(threadId, input.name);
        const { client, cursorSessions } = yield* guestClient(threadId, input.name);
        const session =
          typeof input.arguments.session === "string" && input.arguments.session.length > 0
            ? input.arguments.session
            : undefined;
        return yield* Effect.gen(function* () {
          // The viewer draws presence from cursor hooks even with the guest overlay disabled.
          // Hiding the overlay is cosmetic: a rejection is not retried and never replaces the
          // requested tool's result.
          const configureCursor = Effect.gen(function* () {
            if (cursorSessions.has(session)) return;
            cursorSessions.add(session);
            yield* client["tools/call"]({
              name: "set_agent_cursor_enabled",
              arguments: { enabled: false, ...(session === undefined ? {} : { session }) },
            }).pipe(Effect.ignore);
          });
          // Ended labels reject ordinary tools. Let start_session revive them first.
          if (!["start_session", "end_session", "set_agent_cursor_enabled"].includes(input.tool))
            yield* configureCursor;
          const result = yield* client["tools/call"]({
            name: input.tool,
            arguments: input.arguments,
          });
          if (isEndedSession(result.structuredContent)) cursorSessions.delete(session);
          if (!result.isError) {
            if (input.tool === "end_session") cursorSessions.delete(session);
            if (input.tool === "set_agent_cursor_enabled") cursorSessions.add(session);
            if (input.tool === "start_session") {
              if (isRevivedSession(result.structuredContent)) cursorSessions.delete(session);
              yield* configureCursor;
            }
          }
          return result;
        }).pipe(
          Effect.timeout("60 seconds"),
          // Delivery may already have happened. Evict the transport without replaying input.
          Effect.onError((cause) =>
            cause.reasons.every((reason) => Cause.isFailReason(reason) && isMcpError(reason.error))
              ? Effect.void
              : disconnectGuest(input.name, threadId),
          ),
          Effect.mapError(
            (cause) =>
              new VirtualMachineError({ operation: "control", reason: "command-failed", cause }),
          ),
        );
      },
      (effect, threadId, input) => withMachine(input.name, effect, { threadId }),
    ),
    tools: Effect.fn("VirtualMachineService.tools")(
      function* (threadId, name) {
        yield* requireOpen(threadId, name);
        const { client } = yield* guestClient(threadId, name);
        const result = yield* client["tools/list"]({}).pipe(
          Effect.timeout("60 seconds"),
          Effect.onError((cause) =>
            cause.reasons.every((reason) => Cause.isFailReason(reason) && isMcpError(reason.error))
              ? Effect.void
              : disconnectGuest(name, threadId),
          ),
          Effect.mapError(
            (cause) =>
              new VirtualMachineError({ operation: "tools", reason: "command-failed", cause }),
          ),
        );
        return result.tools;
      },
      (effect, threadId, name) => withMachine(name, effect, { threadId }),
    ),
    // The inner screenshot operation supplies its span.
    screenshot: Effect.fnUntraced(function* (threadId, name) {
      return yield* withMachine(name, screenshot(threadId, name));
    }),
    upload: Effect.fn("VirtualMachineService.upload")(
      function* (threadId, input) {
        yield* requireOpen(threadId, input.name);
        const source = yield* workspacePath(
          "upload",
          threadId,
          input.relativePath,
          "existing-file",
        );
        yield* run("upload", ["sandbox", "cp", source, `local:${input.name}:${input.guestPath}`], {
          timeout: "10 minutes",
        });
      },
      (effect, _threadId, input) => withMachine(input.name, effect),
    ),
    download: Effect.fn("VirtualMachineService.download")(
      function* (threadId, input) {
        yield* requireOpen(threadId, input.name);
        const target = yield* workspacePath("download", threadId, input.relativePath, "new-file");
        yield* run(
          "download",
          ["sandbox", "cp", `local:${input.name}:${input.guestPath}`, target],
          {
            timeout: "10 minutes",
          },
        );
        const stat = yield* fs
          .stat(target)
          .pipe(
            Effect.mapError(
              (cause) =>
                new VirtualMachineError({ operation: "download", reason: "storage", cause }),
            ),
          );
        return { bytes: Number(stat.size) };
      },
      (effect, _threadId, input) => withMachine(input.name, effect),
    ),
    viewerLifetime: Effect.fn("VirtualMachineService.viewerLifetime")(function* (id) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const lease = leases.get(id);
          if (!lease) return;
          const remaining = lease.expiresAt - (yield* Clock.currentTimeMillis);
          if (remaining <= 0) return;
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter(() => !leases.has(id)),
            Stream.runHead,
            Effect.asVoid,
            Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.void }),
          );
        }),
      );
    }),
    viewerUpstream: Effect.fn("VirtualMachineService.viewerUpstream")(function* (id) {
      const lease = leases.get(id);
      if (
        !lease ||
        lease.expiresAt <= (yield* Clock.currentTimeMillis) ||
        !(yield* Ref.get(state)).enabled
      ) {
        leases.delete(id);
        return null;
      }
      return lease.origin;
    }),
  });
});

export const layer = Layer.effect(VirtualMachineService, make);

export const stateStream = (
  service: VirtualMachineService["Service"],
): Stream.Stream<VirtualMachineState> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* service.subscribe;
      const initial = yield* service.state;
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
    }),
  ).pipe(Stream.scoped);
