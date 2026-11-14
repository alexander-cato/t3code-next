import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId, VirtualMachineError, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as VirtualMachineService from "./VirtualMachineService.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeVmError = Schema.encodeSync(VirtualMachineError);
const decodeVmError = Schema.decodeUnknownSync(VirtualMachineError);
const threadId = ThreadId.make("vm-test-thread");
const otherThread = ThreadId.make("other-thread");
const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const fixture = Effect.fn("vm.fixture")(function* (options?: {
  readonly enabled?: boolean;
  readonly machines?: ReadonlyArray<string>;
  readonly status?: string;
  readonly resume?:
    | ProcessRunner.ProcessRunOutput
    | Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  readonly platform?: NodeJS.Platform;
  readonly gateway?: "bundled" | "non-executable";
  readonly environment?: NodeJS.ProcessEnv;
  readonly create?: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  readonly power?: ProcessRunner.ProcessRunOutput;
  readonly exec?: Effect.Effect<ProcessRunner.ProcessRunOutput>;
  readonly list?: (
    count: number,
  ) => ProcessRunner.ProcessRunOutput | Effect.Effect<ProcessRunner.ProcessRunOutput> | undefined;
  readonly view?: (count: number) => Effect.Effect<ProcessRunner.ProcessRunOutput>;
  readonly guestResponse?: (
    method: string,
    session: string | null,
    id: unknown,
    params?: Record<string, unknown>,
  ) => Response | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vm-test-" });
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const requests: {
    method: string;
    session: string | null;
    params?: Record<string, unknown>;
    url: string;
  }[] = [];
  let connectionCount = 0;
  const guestFetch: typeof fetch = async (_url, init) => {
    const url = String(_url);
    if (!["http://192.168.64.2:3211/mcp", "http://192.168.64.3:3211/mcp"].includes(url))
      return new Response(null, { status: 400 });
    const headers = new Headers(init?.headers);
    if (init?.method === "DELETE") {
      requests.push({ method: "DELETE", session: headers.get("mcp-session-id"), url });
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(init?.body));
    if (Object.keys(body).some((key) => !["jsonrpc", "id", "method", "params"].includes(key))) {
      return new Response(null, { status: 400 });
    }
    requests.push({
      url,
      method: body.method,
      session: headers.get("mcp-session-id"),
      params: body.params,
    });
    const response = options?.guestResponse?.(
      body.method,
      headers.get("mcp-session-id"),
      body.id,
      body.params,
    );
    if (response) return response;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "guest", version: "1" },
          }
        : body.method === "tools/list"
          ? { tools: [{ name: "drag", inputSchema: { type: "object" } }] }
          : {
              content: [{ type: "text", text: "done" }],
              structuredContent: {
                element_token: `${headers.get("mcp-session-id")}:1`,
                reused:
                  body.params?.arguments?.element_token === `${headers.get("mcp-session-id")}:1`,
              },
            };
    return new Response(json({ jsonrpc: "2.0", id: body.id, result }), {
      headers: {
        "content-type": "application/json",
        ...(body.method === "initialize"
          ? { "mcp-session-id": `transport-${++connectionCount}` }
          : {}),
      },
    });
  };
  const bin = path.join(root, "bin");
  yield* fs.makeDirectory(bin);
  for (const name of ["lume", "cua"]) {
    const file = path.join(bin, name);
    yield* fs.writeFileString(file, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(file, 0o755);
  }
  const gateway = path.join(root, "Cua.app", "Contents", "MacOS", "cua-netgw");
  if (options?.gateway) {
    yield* fs.makeDirectory(path.dirname(gateway), { recursive: true });
    const executable = path.join(path.dirname(gateway), "cua");
    yield* fs.rename(path.join(bin, "cua"), executable);
    yield* fs.symlink(executable, path.join(bin, "cua"));
    yield* fs.writeFileString(gateway, "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(gateway, options.gateway === "bundled" ? 0o755 : 0o600);
  }
  const settings = path.join(root, "userdata", "virtual-machines", "settings.json");
  yield* fs.makeDirectory(path.dirname(settings), { recursive: true });
  yield* fs.writeFileString(settings, json({ enabled: options?.enabled ?? true }));
  let status = options?.status ?? "stopped";
  let listCount = 0;
  let viewCount = 0;
  const runner = ProcessRunner.ProcessRunner.of({
    run: Effect.fn("fixture.run")(function* (input) {
      calls.push(input);
      const args = input.args.slice(4);
      const origin =
        args[2] === "local:second-vm" ? "http://192.168.64.3:3211" : "http://192.168.64.2:3211";
      switch (args[1]) {
        case "ls": {
          const response = options?.list?.(++listCount);
          return (
            (Effect.isEffect(response) ? yield* response : response) ??
            output(
              json([
                ...(options?.machines ?? ["native-tile"]).map((name) => ({
                  name,
                  status,
                  location: "local",
                  runtime: "lume",
                })),
                { name: "not-a-vm", status: "ready", location: "local", runtime: "qemu" },
                { name: "remote", status: "ready", location: "cloud", runtime: "lume" },
              ]),
            )
          );
        }
        case "mcp":
          if (args.at(-2) === "config")
            return output(
              json({
                type: "http",
                url: `${origin}/mcp`,
                headers: { "x-cua-env-authorization": "Bearer guest-root-secret" },
              }),
            );
          return output(
            json(
              args.at(-1) === "tools"
                ? { tools: [{ name: "drag" }] }
                : { content: [{ type: "text", text: "done" }] },
            ),
          );
        case "view":
          if (options?.view) return yield* options.view(++viewCount);
          return output(
            json({
              url: `${origin}/viewer/#ticket=guest-view-ticket`,
              expires_at_unix: 9999999999,
            }),
          );
        case "resume":
          if (options?.resume)
            return Effect.isEffect(options.resume) ? yield* options.resume : options.resume;
          status = "ready";
          return output("{}");
        case "rm":
          return options?.power ?? output("{}");
        case "suspend":
          if (options?.power) return options.power;
          status = "stopped";
          return output("{}");
        case "exec":
          if (options?.exec) return yield* options.exec;
          return output(json({ stdout: "guest output", stderr: "", returncode: 23 }), 23);
        case "create":
          return options?.create ? yield* options.create : output("{}");
        default:
          return output("{}");
      }
    }),
  });
  const services = yield* Layer.build(
    VirtualMachineService.layer.pipe(
      Layer.provide(ServerConfig.layerTest(root, root)),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, guestFetch)),
      Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
      Layer.provide(Layer.succeed(HostProcess.Platform, options?.platform ?? "darwin")),
      Layer.provide(Layer.succeed(HostProcess.Architecture, "arm64")),
      Layer.provide(Layer.succeed(HostProcess.Environment, { PATH: bin, ...options?.environment })),
    ),
  );
  const vms = Context.get(services, VirtualMachineService.VirtualMachineService);
  return { vms, calls, root, fs, path, requests, gateway };
});

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.effect("requires explicit enablement and leaves unsupported hosts idle", () =>
  provide(
    Effect.gen(function* () {
      const disabled = yield* fixture({ enabled: false });
      expect(
        (yield* disabled.vms.open({ name: "native-tile", threadId }).pipe(Effect.flip)).reason,
      ).toBe("disabled");
      expect((yield* disabled.vms.list).machines).toEqual([]);
      expect(disabled.calls).toEqual([]);
      const linux = yield* fixture({ platform: "linux" });
      expect((yield* linux.vms.list).available).toBe(false);
      expect(linux.calls).toEqual([]);
    }),
  ),
);

it.effect.each([
  { gateway: "bundled", environment: {}, expected: true },
  { gateway: "bundled", environment: { CUA_NETGW: "/custom/cua-netgw" }, expected: false },
  { gateway: "non-executable", environment: {}, expected: false },
  { environment: {}, expected: false },
] as const)(
  "resolves only an executable bundled gateway while preserving explicit CUA_NETGW: %j",
  (input) =>
    provide(
      Effect.gen(function* () {
        const { vms, calls, fs, gateway } = yield* fixture(input);
        yield* vms.list;
        if (input.expected) {
          expect(calls[0]?.env?.CUA_NETGW).toBe(yield* fs.realPath(gateway));
          expect(calls[0]?.env?.PATH).toBeDefined();
        } else {
          expect(calls[0]?.env).toBeUndefined();
        }
      }),
    ),
);

it.effect("lists only local Lume VMs and isolates Cua from the user's global state", () =>
  provide(
    Effect.gen(function* () {
      const { vms, calls, root, path } = yield* fixture();
      expect((yield* vms.list).machines).toEqual([{ name: "native-tile", status: "stopped" }]);
      expect(calls[0]?.args).toEqual([
        "--embedded",
        "--state-dir",
        path.join(root, "userdata", "virtual-machines", "cua"),
        "--json",
        "sandbox",
        "ls",
        "--local",
        "--no-size",
      ]);
    }),
  ),
);

it.effect(
  "opens a guest without launching a host viewer and keeps credentials out of shared state",
  () =>
    provide(
      Effect.gen(function* () {
        const { vms, calls } = yield* fixture();
        const viewer = yield* vms.open({ name: "native-tile", threadId });
        expect(viewer.viewerPath).toMatch(
          /^\/api\/vm-viewer\/[^/]+\/viewer\/#ticket=guest-view-ticket$/,
        );
        expect(calls.some((call) => call.args.includes("resume"))).toBe(true);
        expect(calls.find((call) => call.args.includes("view"))?.args).toContain("--no-open");
        expect(yield* vms.state).toMatchObject({ sessions: [{ name: "native-tile", threadId }] });
        expect(json(yield* vms.state)).not.toContain("secret");
        expect(json(yield* vms.state)).not.toContain("ticket");
        const lease = viewer.viewerPath.split("/")[3]!;
        expect(yield* vms.viewerUpstream(lease)).toBe("http://192.168.64.2:3211/");
        yield* TestClock.adjust("1 hour");
        expect(yield* vms.viewerUpstream(lease)).toBeNull();
      }),
    ),
);

it.effect.each(["ready", "running"])(
  "resumes a guest despite stale %s inventory before requesting its desktop",
  (status) =>
    provide(
      Effect.gen(function* () {
        const { vms, calls } = yield* fixture({
          status,
          view: (): Effect.Effect<ProcessRunner.ProcessRunOutput> =>
            Effect.succeed(
              calls.some((call) => call.args.includes("resume"))
                ? output(
                    json({
                      url: "http://192.168.64.2:3211/viewer/#ticket=guest-view-ticket",
                      expires_at_unix: 9999999999,
                    }),
                  )
                : output("Guest is stopped", 1),
            ),
        });
        yield* vms.open({ name: "native-tile", threadId });
        expect((yield* vms.state).sessions).toEqual([{ name: "native-tile", threadId }]);
      }),
    ),
);

it.effect.each([
  ["unknown", "Start failed", "command-exit", "Cua reported a command failure"],
  ["gateway", "cua-netgw is not available", "network-gateway", "could not locate its cua-netgw"],
  ["disk", "No space left on device", "disk-space", "insufficient disk space"],
  [
    "limit",
    "The maximum number of supported virtual machines has been reached",
    "vm-limit",
    "running VM limit",
  ],
  [
    "download",
    "failed to pull macOS image: registry connection failed",
    "image-download",
    "image could not be downloaded",
  ],
  [
    "service",
    "Lume daemon connection refused",
    "local-service",
    "could not reach its local VM service",
  ],
  ["permission", "Operation not permitted", "permission", "host denied access"],
])(
  "keeps a failed resume private and identifies its %s failure",
  ([_label, stderr, failure, explanation]) =>
    provide(
      Effect.gen(function* () {
        const privateOutput =
          "/Users/example/private Bearer guest-secret https://guest.test/?ticket=private-ticket";
        const { vms, calls } = yield* fixture({
          status: "ready",
          resume: { ...output(privateOutput, 17), stderr: `${stderr}\n${privateOutput}` },
        });
        const error = yield* vms.open({ name: "native-tile", threadId }).pipe(Effect.flip);
        expect(error.operation).toBe("start");
        expect(error.failure).toBe(failure);
        expect(error.message).toContain(explanation);
        expect(error.message).toContain("cua sandbox resume (exit 17)");
        expect(error.diagnosticId).toMatch(/^vm-[a-f0-9]{12}$/);
        const encoded = encodeVmError(error);
        const decoded = decodeVmError(encoded);
        expect(decoded.message).toBe(error.message);
        expect(decoded.command).toBe("cua sandbox resume");
        expect(decoded.exitCode).toBe(17);
        expect(decoded.diagnosticId).toBe(error.diagnosticId);
        for (const privateText of [
          "/Users/example",
          "guest-secret",
          "guest.test",
          "private-ticket",
        ])
          expect(json(encoded)).not.toContain(privateText);
        expect(calls.some((call) => call.args.includes("view"))).toBe(false);
        expect((yield* vms.state).sessions).toEqual([]);
      }),
    ),
);

it.effect.each([
  [
    "timeout",
    new ProcessRunner.ProcessTimeoutError({ command: "cua", argumentCount: 3, timeoutMs: 300_000 }),
  ],
  [
    "spawn",
    new ProcessRunner.ProcessSpawnError({
      command: "cua",
      argumentCount: 3,
      cause: new Error("private-spawn-details"),
    }),
  ],
  [
    "output-limit",
    new ProcessRunner.ProcessOutputLimitError({
      command: "cua",
      argumentCount: 3,
      stream: "stderr",
      maxBytes: 8_000_000,
      observedBytes: 8_000_001,
    }),
  ],
] as const)("distinguishes a %s failure before Cua returns an exit status", ([failure, cause]) =>
  provide(
    Effect.gen(function* () {
      const { vms } = yield* fixture({ resume: Effect.fail(cause) });
      const error = yield* vms.open({ name: "native-tile", threadId }).pipe(Effect.flip);
      expect(error.failure).toBe(failure);
      expect(error.command).toBe("cua sandbox resume");
      expect(error.exitCode).toBeUndefined();
      expect(json(encodeVmError(error))).not.toContain("private-spawn-details");
    }),
  ),
);

it.effect("waits for the HTTP viewer after resume returns a VNC fallback", () =>
  provide(
    Effect.gen(function* () {
      const starting = yield* Deferred.make<void>();
      const { vms, calls } = yield* fixture({
        view: (count) =>
          count === 1
            ? Deferred.succeed(starting, undefined).pipe(
                Effect.as(
                  output(
                    json({
                      name: "local:native-tile",
                      open_command: ["/opt/homebrew/bin/lume", "attach", "native-tile"],
                      opened: false,
                      url: "vnc://192.168.64.2:5900",
                      via: "vnc",
                    }),
                  ),
                ),
              )
            : Effect.succeed(
                output(
                  json({
                    url: "http://192.168.64.2:3211/viewer/#ticket=ready",
                    expires_at_unix: 9999999999,
                  }),
                ),
              ),
      });
      const opening = yield* vms.open({ name: "native-tile", threadId }).pipe(Effect.forkChild);
      yield* Deferred.await(starting);
      expect((yield* vms.state).sessions).toEqual([]);
      yield* TestClock.adjust("2 seconds");
      const viewer = yield* Fiber.join(opening);
      expect(viewer.viewerPath).toMatch(/\/viewer\/#ticket=ready$/);
      expect(calls.filter((call) => call.args.includes("view"))).toHaveLength(2);
      expect(calls.every((call) => call.command === "cua")).toBe(true);
      expect(
        calls
          .filter((call) => call.args.includes("view"))
          .every((call) => call.args.includes("--no-open")),
      ).toBe(true);
      expect(calls.some((call) => call.args.includes("attach"))).toBe(false);
    }),
  ),
);

it.effect("bounds desktop startup waiting and leaves no viewer session on timeout", () =>
  provide(
    Effect.gen(function* () {
      const starting = yield* Deferred.make<void>();
      const { vms, calls } = yield* fixture({
        view: () =>
          Deferred.succeed(starting, undefined).pipe(
            Effect.as(
              output(
                json({
                  name: "local:native-tile",
                  open_command: ["/opt/homebrew/bin/lume", "attach", "native-tile"],
                  opened: false,
                  url: "vnc://192.168.64.2:5900",
                  via: "vnc",
                }),
              ),
            ),
          ),
      });
      const opening = yield* vms
        .open({ name: "native-tile", threadId })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(starting);
      yield* TestClock.adjust("2 minutes");
      const error = yield* Fiber.join(opening);
      expect(error.reason).toBe("command-failed");
      expect(error.message).toContain("The macOS desktop is still starting");
      expect(error.message).toContain("reconnect");
      expect(error.message).not.toContain("Update Cua");
      expect((yield* vms.state).sessions).toEqual([]);
      expect(calls.filter((call) => call.args.includes("view")).length).toBeLessThanOrEqual(61);
    }),
  ),
);

it.effect("rejects malformed viewer responses without retrying", () =>
  provide(
    Effect.gen(function* () {
      const { vms, calls } = yield* fixture({
        view: () => Effect.succeed(output(json({ via: "vnc", url: "vnc://192.168.64.2" }))),
      });
      expect((yield* vms.open({ name: "native-tile", threadId }).pipe(Effect.flip)).reason).toBe(
        "invalid-response",
      );
      expect(calls.filter((call) => call.args.includes("view"))).toHaveLength(1);
    }),
  ),
);

it.effect("still rejects HTTP viewers without a ticket", () =>
  provide(
    Effect.gen(function* () {
      const { vms, calls } = yield* fixture({
        view: () =>
          Effect.succeed(
            output(json({ url: "http://192.168.64.2:3211/viewer/", expires_at_unix: 9999999999 })),
          ),
      });
      expect((yield* vms.open({ name: "native-tile", threadId }).pipe(Effect.flip)).reason).toBe(
        "invalid-response",
      );
      expect(calls.filter((call) => call.args.includes("view"))).toHaveLength(1);
    }),
  ),
);

it.effect("pins guest commands to an open thread and preserves command exit codes", () =>
  provide(
    Effect.gen(function* () {
      const { vms, calls, requests } = yield* fixture();
      expect(
        (yield* vms.exec(threadId, { name: "native-tile", command: "id" }).pipe(Effect.flip))
          .reason,
      ).toBe("not-open");
      yield* vms.open({ name: "native-tile", threadId });
      expect(
        (yield* vms.exec(otherThread, { name: "native-tile", command: "id" }).pipe(Effect.flip))
          .reason,
      ).toBe("not-open");
      const command = "printf '%s' '$(touch /tmp/host-should-not-run); `whoami`'";
      expect(yield* vms.exec(threadId, { name: "native-tile", command })).toEqual({
        stdout: "guest output",
        stderr: "",
        exitCode: 23,
      });
      expect(calls.at(-1)?.args.slice(4)).toEqual([
        "sandbox",
        "exec",
        "local:native-tile",
        "--",
        command,
      ]);
      yield* vms.control(threadId, { name: "native-tile", tool: "drag", arguments: { x: 10 } });
      expect(calls.at(-1)?.args.slice(4)).toEqual([
        "sandbox",
        "mcp",
        "local:native-tile",
        "env",
        "config",
        "--show-secrets",
      ]);
      expect(requests.at(-1)).toMatchObject({
        method: "tools/call",
        session: "transport-1",
        params: { name: "drag", arguments: { x: 10 } },
      });
      expect(json(yield* vms.state)).not.toContain("guest-root-secret");
      expect(calls.at(-1)?.args).not.toContain("guest-root-secret");
      expect(calls.at(-1)?.env).toBeUndefined();
    }),
  ),
);

it.effect("revokes views on close, suspend and disable while preserving VM files", () =>
  provide(
    Effect.gen(function* () {
      const { vms, calls, requests } = yield* fixture();
      const first = yield* vms.open({ name: "native-tile", threadId });
      yield* vms.tools(threadId, "native-tile");
      yield* vms.close({ name: "native-tile", threadId });
      expect((yield* vms.state).closedSessions).toEqual([
        { name: "native-tile", threadId, id: expect.any(String) },
      ]);
      expect(yield* vms.viewerUpstream(first.viewerPath.split("/")[3]!)).toBeNull();
      expect(calls.some((call) => call.args.includes("suspend"))).toBe(false);
      yield* vms.open({ name: "native-tile", threadId });
      expect((yield* vms.state).closedSessions).toEqual([]);
      yield* vms.tools(threadId, "native-tile");
      yield* vms.stop("native-tile");
      expect((yield* vms.state).sessions).toEqual([]);
      const last = yield* vms.open({ name: "native-tile", threadId });
      yield* vms.tools(threadId, "native-tile");
      yield* vms.configure(false);
      expect(
        requests.filter((request) => request.method === "DELETE").map((request) => request.session),
      ).toEqual(["transport-1", "transport-2", "transport-3"]);
      expect(yield* vms.viewerUpstream(last.viewerPath.split("/")[3]!)).toBeNull();
      expect(calls.some((call) => call.args.includes("rm"))).toBe(false);
    }),
  ),
);

it.effect("creates in the background and reports completion without polling", () =>
  provide(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<ProcessRunner.ProcessRunOutput>();
      const { vms, calls } = yield* fixture({
        create: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      });
      yield* vms.create({ name: "new-vm", cpu: 4, memoryGb: 8 });
      yield* Deferred.await(started);
      expect((yield* vms.state).operations).toEqual([
        { name: "new-vm", status: "creating", error: null },
      ]);
      expect(calls.find((call) => call.args.includes("create"))?.args).toEqual(
        expect.arrayContaining(["--on", "local", "--runtime", "lume", "--wait", "desktop"]),
      );
      // Lume's pull API accepts name:tag; digest references fail before downloading.
      expect(calls.find((call) => call.args.includes("create"))?.args[6]).toMatch(
        /^ghcr\.io\/trycua\/macos:26-\d{8}-[a-f0-9]{7}$/,
      );
      expect((yield* vms.configure(false).pipe(Effect.flip)).reason).toBe("busy");
      expect((yield* vms.dismiss("new-vm").pipe(Effect.flip)).reason).toBe("busy");
      const subscription = yield* vms.subscribe;
      yield* Deferred.succeed(finish, output("{}"));
      const completed = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((state) => state.operations.length === 0),
        Stream.runHead,
      );
      expect(Option.isSome(completed)).toBe(true);
    }),
  ),
);

it.effect("keeps a provisioned guest available to open when the post-create refresh fails", () =>
  provide(
    Effect.gen(function* () {
      const { vms, calls } = yield* fixture({
        list: (count) =>
          count === 2
            ? output("", 1)
            : count > 2
              ? output(
                  json([{ name: "new-vm", status: "stopped", location: "local", runtime: "lume" }]),
                )
              : undefined,
      });
      const subscription = yield* vms.subscribe;
      yield* vms.create({ name: "new-vm", cpu: 4, memoryGb: 8 });
      const completed = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(
          (state) =>
            state.operations.some((operation) => operation.status === "failed") ||
            (state.operations.length === 0 &&
              state.machines.some((machine) => machine.name === "new-vm")),
        ),
        Stream.runHead,
      );
      expect(Option.getOrThrow(completed)).toMatchObject({
        machines: expect.arrayContaining([{ name: "new-vm", status: "ready" }]),
        operations: [],
      });
      const viewer = yield* vms.open({ name: "new-vm", threadId });
      expect(viewer.name).toBe("new-vm");
      expect(calls.some((call) => call.args.includes("resume"))).toBe(true);
      expect(calls.filter((call) => call.args.includes("create"))).toHaveLength(1);
    }),
  ),
);

it.effect("retries a real creation failure and still rejects an unrelated existing guest", () =>
  provide(
    Effect.gen(function* () {
      let attempts = 0;
      const { vms, calls } = yield* fixture({
        create: Effect.sync(() => output("{}", ++attempts === 1 ? 1 : 0)),
      });
      expect(
        (yield* vms.create({ name: "native-tile", cpu: 4, memoryGb: 8 }).pipe(Effect.flip)).reason,
      ).toBe("already-exists");
      expect(calls.some((call) => call.args.includes("create"))).toBe(false);
      const subscription = yield* vms.subscribe;
      yield* vms.create({ name: "new-vm", cpu: 4, memoryGb: 8 });
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((state) =>
          state.operations.some((operation) => operation.status === "failed"),
        ),
        Stream.runHead,
      );
      yield* vms.create({ name: "new-vm", cpu: 4, memoryGb: 8 });
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((state) => state.operations.length === 0),
        Stream.runHead,
      );
      expect(attempts).toBe(2);
    }),
  ),
);

it.effect("uploads workspace artifacts and rejects paths or symlinks outside the workspace", () =>
  provide(
    Effect.gen(function* () {
      const { vms, calls, root, fs, path } = yield* fixture();
      yield* vms.open({ name: "native-tile", threadId });
      const workspace = path.join(root, "workspace");
      yield* fs.makeDirectory(workspace);
      yield* fs.writeFileString(path.join(workspace, "build.tar"), "test build");
      const outside = path.join(root, "private.txt");
      yield* fs.writeFileString(outside, "outside");
      yield* fs.symlink(outside, path.join(workspace, "link.txt"));
      // threadWorkspaceRoot reads only the shell's worktree path in this fixture.
      const shell = { worktreePath: workspace } as OrchestrationV2ThreadShell;
      const layer = Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
      );
      for (const relativePath of ["../private.txt", outside, "link.txt"]) {
        const error = yield* vms
          .upload(threadId, { name: "native-tile", relativePath, guestPath: "/tmp/artifact" })
          .pipe(Effect.provide(layer), Effect.flip);
        expect(error.reason).toBe("not-found");
      }
      expect(calls.some((call) => call.args.includes("cp"))).toBe(false);
      yield* vms
        .upload(threadId, {
          name: "native-tile",
          relativePath: "build.tar",
          guestPath: "/tmp/build.tar",
        })
        .pipe(Effect.provide(layer));
      expect(calls.at(-1)?.args.slice(4)).toEqual([
        "sandbox",
        "cp",
        yield* fs.realPath(path.join(workspace, "build.tar")),
        "local:native-tile:/tmp/build.tar",
      ]);
    }),
  ),
);

it.effect("records a failed background creation so it can be retried", () =>
  provide(
    Effect.gen(function* () {
      const finish = yield* Deferred.make<ProcessRunner.ProcessRunOutput>();
      const started = yield* Deferred.make<void>();
      const { vms, calls } = yield* fixture({
        create: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      });
      yield* vms.create({ name: "new-vm", cpu: 4, memoryGb: 8 });
      yield* Deferred.await(started);
      const subscription = yield* vms.subscribe;
      yield* Deferred.succeed(finish, {
        ...output("", 1),
        stderr:
          "\u001b[33mWARN\u001b[0m lume serve is older than cua needs\n" +
          "cua: local runtime: [local] cua-netgw is not available: set CUA_NETGW to its path\n" +
          "Private context: /Users/example/private Bearer guest-secret http://localhost:3211/?ticket=private-ticket",
      });
      const failed = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((state) =>
          state.operations.some((operation) => operation.status === "failed"),
        ),
        Stream.runHead,
      );
      expect(Option.getOrThrow(failed).operations[0]).toMatchObject({
        name: "new-vm",
        status: "failed",
      });
      const message = Option.getOrThrow(failed).operations[0]?.error;
      expect(message).toContain("cua sandbox create");
      expect(message).toContain("exit 1");
      expect(message).toContain("cua-netgw");
      expect(message).toContain("CUA_NETGW");
      expect(message).toContain("Diagnostic ID:");
      for (const privateText of ["/Users/example", "guest-secret", "localhost", "private-ticket"])
        expect(message).not.toContain(privateText);
      const callsBeforeDismiss = calls.length;
      yield* vms.dismiss("new-vm");
      expect((yield* vms.state).operations).toEqual([]);
      expect(calls).toHaveLength(callsBeforeDismiss);
    }),
  ),
);

it.effect("preserves AX tokens on one transport per thread and revokes it on close", () =>
  provide(
    Effect.gen(function* () {
      const { vms, requests } = yield* fixture();
      yield* vms.open({ name: "native-tile", threadId });
      const snapshot = yield* vms.control(threadId, {
        name: "native-tile",
        tool: "get_window_state",
        arguments: { session: "calculator" },
      });
      expect(snapshot).toMatchObject({ structuredContent: { element_token: "transport-1:1" } });
      yield* vms.tools(threadId, "native-tile");
      yield* vms.open({ name: "native-tile", threadId });
      const click = yield* vms.control(threadId, {
        name: "native-tile",
        tool: "click",
        arguments: { session: "calculator", element_token: "transport-1:1" },
      });
      expect(click).toMatchObject({ structuredContent: { reused: true } });
      expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1);
      yield* vms.open({ name: "native-tile", threadId: otherThread });
      yield* vms.tools(otherThread, "native-tile");
      expect(requests.at(-1)?.session).toBe("transport-2");
      yield* vms.close({ name: "native-tile", threadId });
      expect(requests.at(-1)).toMatchObject({ method: "DELETE", session: "transport-1" });
      yield* vms.open({ name: "native-tile", threadId });
      yield* vms.tools(threadId, "native-tile");
      expect(requests.at(-1)?.session).toBe("transport-3");
    }),
  ),
);

it.effect("keeps two VMs open in one thread with isolated persistent guest tokens", () =>
  provide(
    Effect.gen(function* () {
      const { vms, requests } = yield* fixture({ machines: ["native-tile", "second-vm"] });
      const first = yield* vms.open({ name: "native-tile", threadId });
      yield* vms.tools(threadId, "native-tile");
      const firstSnapshot = yield* vms.control(threadId, {
        name: "native-tile",
        tool: "get_window_state",
        arguments: {},
      });
      expect(firstSnapshot).toMatchObject({
        structuredContent: { element_token: "transport-1:1" },
      });
      const second = yield* vms.open({ name: "second-vm", threadId });
      yield* vms.tools(threadId, "second-vm");
      const secondSnapshot = yield* vms.control(threadId, {
        name: "second-vm",
        tool: "get_window_state",
        arguments: {},
      });
      expect(secondSnapshot).toMatchObject({
        structuredContent: { element_token: "transport-2:1" },
      });
      for (const [name, token, url] of [
        ["native-tile", "transport-1:1", "http://192.168.64.2:3211/mcp"],
        ["second-vm", "transport-2:1", "http://192.168.64.3:3211/mcp"],
      ] as const) {
        yield* vms.tools(threadId, name);
        expect(
          yield* vms.control(threadId, {
            name,
            tool: "click",
            arguments: { element_token: token },
          }),
        ).toMatchObject({ structuredContent: { reused: true } });
        expect(requests.at(-1)).toMatchObject({ url, session: token.split(":")[0] });
        expect(
          yield* vms.control(threadId, {
            name,
            tool: "click",
            arguments: {
              element_token: token === "transport-1:1" ? "transport-2:1" : "transport-1:1",
            },
          }),
        ).toMatchObject({ structuredContent: { reused: false } });
      }
      yield* vms.open({ name: "native-tile", threadId });
      expect((yield* vms.state).sessions).toHaveLength(2);
      expect(yield* vms.viewerUpstream(first.viewerPath.split("/")[3]!)).toBe(
        "http://192.168.64.2:3211/",
      );
      expect(yield* vms.viewerUpstream(second.viewerPath.split("/")[3]!)).toBe(
        "http://192.168.64.3:3211/",
      );
      expect(requests.filter((request) => request.method === "initialize")).toHaveLength(2);
      expect(requests.filter((request) => request.method === "DELETE")).toEqual([]);
    }),
  ),
);

it.effect("closing one VM preserves the thread's other VM and the same VM in another thread", () =>
  provide(
    Effect.gen(function* () {
      const { vms, requests } = yield* fixture({ machines: ["native-tile", "second-vm"] });
      const first = yield* vms.open({ name: "native-tile", threadId });
      yield* vms.tools(threadId, "native-tile");
      const second = yield* vms.open({ name: "second-vm", threadId });
      yield* vms.tools(threadId, "second-vm");
      const other = yield* vms.open({ name: "native-tile", threadId: otherThread });
      yield* vms.tools(otherThread, "native-tile");
      expect(requests.filter((request) => request.method === "DELETE")).toEqual([]);
      yield* vms.close({ name: "native-tile", threadId });
      expect((yield* vms.state).sessions).toEqual([
        { name: "second-vm", threadId },
        { name: "native-tile", threadId: otherThread },
      ]);
      expect(yield* vms.viewerUpstream(first.viewerPath.split("/")[3]!)).toBeNull();
      expect(yield* vms.viewerUpstream(second.viewerPath.split("/")[3]!)).not.toBeNull();
      expect(yield* vms.viewerUpstream(other.viewerPath.split("/")[3]!)).not.toBeNull();
      expect((yield* vms.tools(threadId, "native-tile").pipe(Effect.flip)).reason).toBe("not-open");
      for (const [id, name, token] of [
        [threadId, "second-vm", "transport-2:1"],
        [otherThread, "native-tile", "transport-3:1"],
      ] as const) {
        yield* vms.tools(id, name);
        expect(
          yield* vms.control(id, { name, tool: "click", arguments: { element_token: token } }),
        ).toMatchObject({ structuredContent: { reused: true } });
      }
      expect(requests.filter((request) => request.method === "DELETE")).toMatchObject([
        { session: "transport-1" },
      ]);
      expect(requests.filter((request) => request.method === "initialize")).toHaveLength(3);
    }),
  ),
);

it.effect.each(["stop", "remove"] as const)(
  "%s revokes a VM across threads and preserves another VM in the same thread",
  (action) =>
    provide(
      Effect.gen(function* () {
        const { vms, requests } = yield* fixture({ machines: ["native-tile", "second-vm"] });
        const first = yield* vms.open({ name: "native-tile", threadId });
        yield* vms.tools(threadId, "native-tile");
        const second = yield* vms.open({ name: "second-vm", threadId });
        yield* vms.tools(threadId, "second-vm");
        const other = yield* vms.open({ name: "native-tile", threadId: otherThread });
        yield* vms.tools(otherThread, "native-tile");
        yield* vms[action]("native-tile");
        expect((yield* vms.state).sessions).toEqual([{ name: "second-vm", threadId }]);
        for (const viewer of [first, other]) {
          expect(yield* vms.viewerUpstream(viewer.viewerPath.split("/")[3]!)).toBeNull();
        }
        expect(yield* vms.viewerUpstream(second.viewerPath.split("/")[3]!)).not.toBeNull();
        expect(
          requests
            .filter((request) => request.method === "DELETE")
            .map((request) => request.session),
        ).toEqual(["transport-1", "transport-3"]);
        expect(
          yield* vms.control(threadId, {
            name: "second-vm",
            tool: "click",
            arguments: { element_token: "transport-2:1" },
          }),
        ).toMatchObject({ structuredContent: { reused: true } });
      }),
    ),
);

it.effect.each(["disable", "dispose"] as const)(
  "%s revokes every VM connection and viewer",
  (action) =>
    provide(
      Effect.gen(function* () {
        const { vms, requests, viewers } = yield* Effect.scoped(
          Effect.gen(function* () {
            const fixtureValue = yield* fixture({ machines: ["native-tile", "second-vm"] });
            const { vms } = fixtureValue;
            const viewers = [];
            for (const [name, id] of [
              ["native-tile", threadId],
              ["second-vm", threadId],
              ["native-tile", otherThread],
            ] as const) {
              viewers.push(yield* vms.open({ name, threadId: id }));
              yield* vms.tools(id, name);
            }
            if (action === "disable") {
              yield* vms.configure(false);
              expect((yield* vms.state).sessions).toEqual([]);
              expect(
                fixtureValue.requests.filter((request) => request.method === "DELETE"),
              ).toHaveLength(3);
              for (const viewer of viewers) {
                expect(yield* vms.viewerUpstream(viewer.viewerPath.split("/")[3]!)).toBeNull();
              }
            }
            return { ...fixtureValue, viewers };
          }),
        );
        expect((yield* vms.state).sessions).toEqual([]);
        for (const viewer of viewers) {
          expect(yield* vms.viewerUpstream(viewer.viewerPath.split("/")[3]!)).toBeNull();
        }
        expect(
          requests
            .filter((request) => request.method === "DELETE")
            .map((request) => request.session)
            .sort(),
        ).toEqual(["transport-1", "transport-2", "transport-3"]);
      }),
    ),
);

it.effect.each(["refresh", "open", "stop", "remove"] as const)(
  "keeps the newer inventory after %s when an older refresh finishes last",
  (action) =>
    provide(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const status = action === "open" ? "stopped" : "ready";
        const oldInventory = output(
          json([{ name: "native-tile", status, location: "local", runtime: "lume" }]),
        );
        const { vms } = yield* fixture({
          status,
          list: (count) =>
            count === 1
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.as(oldInventory),
                )
              : action === "remove" && count === 3
                ? output("[]")
                : action === "refresh"
                  ? output(
                      json([
                        {
                          name: "native-tile",
                          status: "stopped",
                          location: "local",
                          runtime: "lume",
                        },
                      ]),
                    )
                  : undefined,
        });
        const refreshing = yield* vms.list.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        if (action === "refresh") yield* vms.list;
        else if (action === "open") yield* vms.open({ name: "native-tile", threadId });
        else yield* vms[action]("native-tile");
        const expected =
          action === "remove"
            ? []
            : [{ name: "native-tile", status: action === "open" ? "ready" : "stopped" }];
        expect((yield* vms.state).machines).toEqual(expected);
        yield* Deferred.succeed(finish, undefined);
        expect((yield* Fiber.join(refreshing)).machines).toEqual(expected);
        expect((yield* vms.state).machines).toEqual(expected);
      }),
    ),
);

it.effect("returns an acquired viewer even when the status refresh fails", () =>
  provide(
    Effect.gen(function* () {
      const { vms } = yield* fixture({
        list: (count) => (count === 2 ? output("", 1) : undefined),
      });
      const viewer = yield* vms.open({ name: "native-tile", threadId });
      expect(yield* vms.viewerUpstream(viewer.viewerPath.split("/")[3]!)).not.toBeNull();
      expect((yield* vms.state).sessions).toEqual([{ name: "native-tile", threadId }]);
    }),
  ),
);

it.effect("reconnects after transport loss without replaying uncertain guest input", () =>
  provide(
    Effect.gen(function* () {
      let failNext = true;
      const { vms, requests } = yield* fixture({
        guestResponse: (method, _transport, _id, params) => {
          if (method === "tools/call" && params?.name === "click" && failNext) {
            failNext = false;
            return new Response(null, { status: 404 });
          }
        },
      });
      yield* vms.open({ name: "native-tile", threadId });
      const failed = yield* vms
        .control(threadId, { name: "native-tile", tool: "click", arguments: {} })
        .pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(requests.filter((request) => request.params?.name === "click")).toHaveLength(1);
      yield* vms.tools(threadId, "native-tile");
      expect(requests.at(-1)).toMatchObject({ method: "tools/list", session: "transport-2" });
      expect(requests.filter((request) => request.method === "initialize")).toHaveLength(2);
    }),
  ),
);

it.effect("opens another VM in the same thread while a desktop is still starting", () =>
  provide(
    Effect.gen(function* () {
      const starting = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<ProcessRunner.ProcessRunOutput>();
      const { vms } = yield* fixture({
        list: () =>
          output(
            json([
              { name: "native-tile", status: "ready", location: "local", runtime: "lume" },
              { name: "second-vm", status: "ready", location: "local", runtime: "lume" },
            ]),
          ),
        view: (count) =>
          count === 1
            ? Deferred.succeed(starting, undefined).pipe(Effect.andThen(Deferred.await(finish)))
            : Effect.succeed(
                output(
                  json({
                    url: "http://192.168.64.2:3211/viewer/#ticket=second",
                    expires_at_unix: 9999999999,
                  }),
                ),
              ),
      });
      const opening = yield* vms.open({ name: "native-tile", threadId }).pipe(Effect.forkChild);
      yield* Deferred.await(starting);
      const second = yield* vms.open({ name: "second-vm", threadId });
      expect(second.name).toBe("second-vm");
      yield* Deferred.succeed(
        finish,
        output(
          json({
            url: "http://192.168.64.2:3211/viewer/#ticket=first",
            expires_at_unix: 9999999999,
          }),
        ),
      );
      yield* Fiber.join(opening);
    }),
  ),
);

it.effect("a running guest command holds up neither other threads nor closing its view", () =>
  provide(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const { vms } = yield* fixture({
        status: "ready",
        exec: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as(output(json({ stdout: "", stderr: "", returncode: 0 }))),
        ),
      });
      yield* vms.open({ name: "native-tile", threadId });
      yield* vms.open({ name: "native-tile", threadId: otherThread });
      const running = yield* vms
        .exec(threadId, { name: "native-tile", command: "xcodebuild test" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* vms.control(otherThread, { name: "native-tile", tool: "click", arguments: {} });
      yield* vms.screenshot(otherThread, "native-tile").pipe(Effect.ignore);
      yield* vms.close({ name: "native-tile", threadId });
      expect((yield* vms.state).sessions).toEqual([{ name: "native-tile", threadId: otherThread }]);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(running);
    }),
  ),
);

it.effect("does not broadcast an inventory refresh that changed nothing", () =>
  provide(
    Effect.gen(function* () {
      const { vms } = yield* fixture();
      yield* vms.list;
      const changes = yield* vms.subscribe;
      yield* vms.list;
      expect(yield* PubSub.takeUpTo(changes, 10)).toEqual([]);
    }),
  ),
);

it.effect("preserves guest tokens after a rejected tool request", () =>
  provide(
    Effect.gen(function* () {
      let rejectNext = true;
      const { vms, requests } = yield* fixture({
        guestResponse: (method, _session, id, params) => {
          if (method === "tools/call" && params?.name === "click" && rejectNext) {
            rejectNext = false;
            return new Response(
              json({
                jsonrpc: "2.0",
                id,
                error: { code: -32602, message: "Invalid tool arguments" },
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
        },
      });
      yield* vms.open({ name: "native-tile", threadId });
      const failed = yield* vms
        .control(threadId, { name: "native-tile", tool: "click", arguments: {} })
        .pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      yield* vms.tools(threadId, "native-tile");
      expect(requests.at(-1)?.session).toBe("transport-1");
      expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    }),
  ),
);

it.effect("evicts a failed tools transport before the next guest request", () =>
  provide(
    Effect.gen(function* () {
      let failNext = true;
      const { vms, requests } = yield* fixture({
        guestResponse: (method) => {
          if (method === "tools/list" && failNext) {
            failNext = false;
            return new Response(null, { status: 503 });
          }
        },
      });
      yield* vms.open({ name: "native-tile", threadId });
      const failed = yield* vms.tools(threadId, "native-tile").pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      yield* vms.control(threadId, { name: "native-tile", tool: "click", arguments: {} });
      expect(requests.at(-1)).toMatchObject({ method: "tools/call", session: "transport-2" });
      expect(requests.filter((request) => request.method === "tools/list")).toHaveLength(1);
    }),
  ),
);

it.effect.each(["stop", "remove"] as const)(
  "commits successful %s even when the inventory refresh fails",
  (action) =>
    provide(
      Effect.gen(function* () {
        const { vms, calls } = yield* fixture({
          list: (count) => (count === 3 ? output("", 1) : undefined),
        });
        const viewer = yield* vms.open({ name: "native-tile", threadId });
        yield* vms[action]("native-tile");
        const current = yield* vms.state;
        expect(current.sessions).toEqual([]);
        expect(current.machines).toEqual(
          action === "remove" ? [] : [{ name: "native-tile", status: "stopped" }],
        );
        expect(yield* vms.viewerUpstream(viewer.viewerPath.split("/")[3]!)).toBeNull();
        expect(calls.filter((call) => call.args.includes("ls"))).toHaveLength(3);
        expect(
          calls.filter((call) => call.args.includes(action === "remove" ? "rm" : "suspend")),
        ).toHaveLength(1);
      }),
    ),
);

it.effect.each(["stop", "remove"] as const)(
  "keeps the current power state when the %s command fails",
  (action) =>
    provide(
      Effect.gen(function* () {
        const { vms, calls } = yield* fixture({ power: output("", 1) });
        const viewer = yield* vms.open({ name: "native-tile", threadId });
        const error = yield* vms[action]("native-tile").pipe(Effect.flip);
        expect(error.reason).toBe("command-failed");
        expect(error.operation).toBe(action === "remove" ? "delete" : "stop");
        expect((yield* vms.state).machines).toEqual([{ name: "native-tile", status: "ready" }]);
        expect((yield* vms.state).sessions).toEqual([{ name: "native-tile", threadId }]);
        expect(yield* vms.viewerUpstream(viewer.viewerPath.split("/")[3]!)).not.toBeNull();
        expect(calls.filter((call) => call.args.includes("ls"))).toHaveLength(2);
      }),
    ),
);

it.effect(
  "disables the guest cursor once per implicit or named session and preserves explicit choices",
  () =>
    provide(
      Effect.gen(function* () {
        const { vms, requests } = yield* fixture({ machines: ["native-tile", "second-vm"] });
        yield* vms.open({ name: "native-tile", threadId });
        for (const args of [{}, { session: "calculator" }, {}, { session: "calculator" }]) {
          yield* vms.control(threadId, { name: "native-tile", tool: "click", arguments: args });
        }
        const toolCalls = () => requests.filter((request) => request.method === "tools/call");
        expect(toolCalls().map((request) => request.params)).toEqual([
          { name: "set_agent_cursor_enabled", arguments: { enabled: false } },
          { name: "click", arguments: {} },
          {
            name: "set_agent_cursor_enabled",
            arguments: { enabled: false, session: "calculator" },
          },
          { name: "click", arguments: { session: "calculator" } },
          { name: "click", arguments: {} },
          { name: "click", arguments: { session: "calculator" } },
        ]);
        for (const args of [
          { enabled: true },
          { enabled: true, session: "calculator" },
          { enabled: true, session: "explicit-first" },
        ]) {
          yield* vms.control(threadId, {
            name: "native-tile",
            tool: "set_agent_cursor_enabled",
            arguments: args,
          });
          yield* vms.control(threadId, {
            name: "native-tile",
            tool: "click",
            arguments: "session" in args ? { session: args.session } : {},
          });
        }
        expect(
          toolCalls().filter((request) => request.params?.name === "set_agent_cursor_enabled"),
        ).toHaveLength(5);
        yield* vms.open({ name: "native-tile", threadId: otherThread });
        yield* vms.control(otherThread, {
          name: "native-tile",
          tool: "click",
          arguments: { session: "calculator" },
        });
        yield* vms.open({ name: "second-vm", threadId });
        yield* vms.control(threadId, {
          name: "second-vm",
          tool: "click",
          arguments: { session: "calculator" },
        });
        expect(
          toolCalls()
            .filter((request) => request.params?.name === "set_agent_cursor_enabled")
            .map((request) => request.session),
        ).toEqual([
          "transport-1",
          "transport-1",
          "transport-1",
          "transport-1",
          "transport-1",
          "transport-2",
          "transport-3",
        ]);
      }),
    ),
);

it.effect.each([undefined, "calculator"])(
  "reconfigures a revived cursor session %s after start_session",
  (session) =>
    provide(
      Effect.gen(function* () {
        let ended = false;
        const { vms, requests } = yield* fixture({
          guestResponse: (method, _transport, id, params) => {
            if (method !== "tools/call") return;
            const name = params?.name;
            const reply = (result: unknown) =>
              new Response(json({ jsonrpc: "2.0", id, result }), {
                headers: { "content-type": "application/json" },
              });
            if (name === "start_session") {
              const revived = ended;
              ended = false;
              return reply({ content: [], structuredContent: { revived } });
            }
            if (ended)
              return reply({
                content: [],
                isError: true,
                structuredContent: { code: "session_ended" },
              });
            if (name === "end_session") ended = true;
          },
        });
        const args = session ? { session } : {};
        yield* vms.open({ name: "native-tile", threadId });
        for (const tool of [
          "click",
          "end_session",
          "click",
          "start_session",
          "click",
          "start_session",
          "click",
        ]) {
          const result = yield* vms.control(threadId, {
            name: "native-tile",
            tool,
            arguments: args,
          });
          if (tool === "click" && ended) expect(result.isError).toBe(true);
        }
        expect(
          requests
            .filter((request) => request.method === "tools/call")
            .map((request) => request.params?.name),
        ).toEqual([
          "set_agent_cursor_enabled",
          "click",
          "end_session",
          "set_agent_cursor_enabled",
          "click", // The ended label rejects setup and input alike.
          "start_session",
          "set_agent_cursor_enabled",
          "click",
          "start_session",
          "click",
        ]);
      }),
    ),
);

it.effect.each(["tool", "rpc", "transport"] as const)(
  "cursor setup %s failure still delivers the requested input once",
  (failure) =>
    provide(
      Effect.gen(function* () {
        let failNext = true;
        const { vms, requests } = yield* fixture({
          guestResponse: (method, transport, id, params) => {
            if (
              method !== "tools/call" ||
              params?.name !== "set_agent_cursor_enabled" ||
              transport !== "transport-1" ||
              !failNext
            )
              return;
            failNext = false;
            if (failure === "transport") return new Response(null, { status: 503 });
            return new Response(
              json({
                jsonrpc: "2.0",
                id,
                ...(failure === "rpc"
                  ? { error: { code: -32602, message: "rejected" } }
                  : { result: { content: [], isError: true } }),
              }),
              { headers: { "content-type": "application/json" } },
            );
          },
        });
        yield* vms.open({ name: "native-tile", threadId });
        const first = yield* vms.control(threadId, {
          name: "native-tile",
          tool: "click",
          arguments: {},
        });
        expect(first.isError).toBeFalsy();
        expect(requests.filter((request) => request.params?.name === "click")).toHaveLength(1);
        yield* vms.open({ name: "native-tile", threadId: otherThread });
        yield* vms.control(otherThread, { name: "native-tile", tool: "click", arguments: {} });
        yield* vms.control(threadId, { name: "native-tile", tool: "click", arguments: {} });
        expect(requests.filter((request) => request.params?.name === "click")).toHaveLength(3);
        expect(
          requests.filter((request) => request.params?.name === "set_agent_cursor_enabled"),
        ).toHaveLength(2);
      }),
    ),
);

it.effect("clears cursor setup after session_ended and leaves failed revival untouched", () =>
  provide(
    Effect.gen(function* () {
      let clicks = 0;
      let starts = 0;
      const { vms, requests } = yield* fixture({
        guestResponse: (method, _transport, id, params) => {
          if (method !== "tools/call") return;
          const name = params?.name;
          const result =
            name === "click" && ++clicks === 2
              ? { content: [], isError: true, structuredContent: { code: "session_ended" } }
              : name === "start_session"
                ? ++starts === 1
                  ? {
                      content: [],
                      isError: true,
                      structuredContent: { code: "session_unavailable" },
                    }
                  : { content: [], structuredContent: { revived: true } }
                : undefined;
          if (result)
            return new Response(json({ jsonrpc: "2.0", id, result }), {
              headers: { "content-type": "application/json" },
            });
        },
      });
      yield* vms.open({ name: "native-tile", threadId });
      for (const tool of ["click", "click", "start_session", "start_session", "click"]) {
        yield* vms.control(threadId, {
          name: "native-tile",
          tool,
          arguments: { session: "calculator" },
        });
      }
      expect(
        requests
          .filter((request) => request.method === "tools/call")
          .map((request) => request.params?.name),
      ).toEqual([
        "set_agent_cursor_enabled",
        "click",
        "click",
        "start_session",
        "start_session",
        "set_agent_cursor_enabled",
        "click",
      ]);
      expect(clicks).toBe(3);
    }),
  ),
);
