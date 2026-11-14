import {
  VirtualMachineError,
  VirtualMachineName,
  type ThreadId,
  type VirtualMachineControlInput,
  type VirtualMachineCreateInput,
  type VirtualMachineExecInput,
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
    /maximum number of (?:supported )?virtual machines|(?:running|concurrent) vm limit|virtual machine limit/i.test(
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
    ) => Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, VirtualMachineError>;
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
      return yield* new VirtualMachineError({ operation: "control", reason: "not-open" });
    }
  });
  const forget = Effect.fn("VirtualMachineService.forget")(function* (
    name: string,
    threadId?: ThreadId,
  ) {
    const id = yield* random.uuidV4().pipe(Effect.orDie);
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
      yield* disconnectGuest();
    }
    yield* publish((value) => ({ ...value, enabled, sessions: enabled ? value.sessions : [] }));
    return yield* list();
  });
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
    yield* publish((value) => ({
      ...value,
      operations: [
        ...value.operations.filter((operation) => operation.name !== input.name),
        { name: input.name, status: "creating", error: null },
      ],
    }));
    yield* run(
      "create",
      [
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
      ],
      { timeout: "60 minutes" },
    ).pipe(
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
      run("start", ["sandbox", "resume", `local:${input.name}`], { timeout: "5 minutes" }),
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
    yield* forget(name);
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
      yield* withMachine(input.name, forget(input.name, input.threadId), {
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
        // The command is one argv element after `--`, so a leading hyphen is never a Cua option.
        // Cua executes it in the guest shell; the server never interpolates it into a host shell.
        const result = yield* run(
          "exec",
          ["sandbox", "exec", `local:${input.name}`, "--", input.command],
          {
            allowFailure: true,
            timeout: "5 minutes",
          },
        );
        const reply = yield* decode(ExecReply, result.stdout);
        return { stdout: reply.stdout, stderr: reply.stderr, exitCode: reply.returncode };
      },
      (effect, _threadId, input) => withMachine(input.name, effect),
    ),
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
        const workspace = yield* threadWorkspaceRoot(threadId);
        if (!workspace || path.isAbsolute(input.relativePath))
          return yield* new VirtualMachineError({ operation: "upload", reason: "not-found" });
        const rootPath = yield* fs
          .realPath(workspace)
          .pipe(
            Effect.mapError(
              (cause) => new VirtualMachineError({ operation: "upload", reason: "storage", cause }),
            ),
          );
        const source = yield* fs
          .realPath(path.resolve(rootPath, input.relativePath))
          .pipe(
            Effect.mapError(
              (cause) => new VirtualMachineError({ operation: "upload", reason: "storage", cause }),
            ),
          );
        const relative = path.relative(rootPath, source);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          return yield* new VirtualMachineError({ operation: "upload", reason: "not-found" });
        const stat = yield* fs
          .stat(source)
          .pipe(
            Effect.mapError(
              (cause) => new VirtualMachineError({ operation: "upload", reason: "storage", cause }),
            ),
          );
        if (stat.type !== "File")
          return yield* new VirtualMachineError({ operation: "upload", reason: "not-found" });
        yield* run("upload", ["sandbox", "cp", source, `local:${input.name}:${input.guestPath}`], {
          timeout: "10 minutes",
        });
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
