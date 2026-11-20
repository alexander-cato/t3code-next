import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DevinSettings } from "../settings.ts";
import { checkDevinProviderStatus } from "./status.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(DevinSettings)({ enabled: true });

// Shapes recorded from Devin CLI 3000.14.30821 (`devin acp`), trimmed to a few choices.
const SESSION_NEW_RESULT = {
  sessionId: "probe-session",
  modes: {
    currentModeId: "accept-edits",
    availableModes: [
      { id: "accept-edits", name: "Code" },
      { id: "plan", name: "Plan" },
      { id: "bypass", name: "Bypass Permissions" },
    ],
  },
  configOptions: [
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "accept-edits",
      options: [
        { value: "accept-edits", name: "Code" },
        { value: "plan", name: "Plan" },
        { value: "bypass", name: "Bypass Permissions" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "swe-2-high",
      options: [
        { value: "swe-2-high", name: "SWE-2" },
        { value: "swe-2-flash-medium", name: "SWE-2 Flash" },
        { value: "claude-opus-5-5-medium", name: "Claude Opus 5.5" },
      ],
    },
    {
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ],
    },
    {
      id: "speed",
      name: "Speed",
      category: "model_config",
      type: "select",
      currentValue: "standard",
      options: [
        { value: "standard", name: "Standard" },
        { value: "fast", name: "Fast" },
      ],
    },
  ],
};
const AVAILABLE_COMMANDS = [
  { name: "compact", description: "Force conversation compaction" },
  {
    name: "plan",
    description: "Switch to Plan mode, or plan with a prompt",
    input: { hint: "[prompt]" },
  },
  {
    name: "file-pr",
    description: "File a concise pull request.",
    _meta: { "cognition.ai/category": "Skills" },
  },
];

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.Union([Schema.String, Schema.Number]), method: Schema.String }),
  ),
);

/** A `devin acp` that scripts session setup and records every request method it receives. */
const acpProcess = (methods: Array<string>, sessionNew: "ok" | "fail") =>
  Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array>();
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const terminate = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(
      Effect.andThen(Queue.shutdown(output)),
      Effect.asVoid,
    );
    const send = (message: Record<string, unknown>) =>
      Queue.offer(output, encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
    const reply = (line: string) =>
      Effect.gen(function* () {
        const request = decodeRequest(line);
        methods.push(request.method);
        if (request.method === "initialize") {
          return yield* send({
            id: request.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, sessionCapabilities: { delete: {} } },
              authMethods: [],
            },
          });
        }
        if (request.method === "session/new" && sessionNew === "ok") {
          yield* send({
            method: "session/update",
            params: {
              sessionId: "probe-session",
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: AVAILABLE_COMMANDS,
              },
            },
          });
          return yield* send({ id: request.id, result: SESSION_NEW_RESULT });
        }
        if (request.method === "session/delete") return yield* send({ id: request.id, result: {} });
        return yield* send({
          id: request.id,
          error: { code: -32603, message: `${request.method} is not scripted` },
        });
      });
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(900_000_013),
      exitCode: Deferred.await(exited),
      isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
      kill: () => terminate,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.forEach((bytes: Uint8Array) =>
        Effect.forEach(
          new TextDecoder()
            .decode(bytes)
            .split("\n")
            .filter((line) => line.trim().length > 0),
          reply,
        ),
      ),
      stdout: Stream.fromQueue(output),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  });

const cliOutput = (output: { readonly stdout: string; readonly code: number }) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_012),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.succeed(encoder.encode(output.stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const check = (
  authStatus: { readonly stdout: string; readonly code: number },
  sessionNew: "ok" | "fail" = "ok",
) =>
  Effect.gen(function* () {
    const invoked: Array<string> = [];
    const methods: Array<string> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args.join(" ") : "";
      invoked.push(args);
      if (args === "acp") return acpProcess(methods, sessionNew);
      return Effect.succeed(
        cliOutput(
          args === "--version"
            ? { stdout: "devin 3000.14.30821 (a09cd7f323ee)\n", code: 0 }
            : args === "auth status"
              ? authStatus
              : { stdout: "", code: 127 },
        ),
      );
    });
    const snapshot = yield* checkDevinProviderStatus(settings, {}).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return { snapshot, invoked, methods };
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const SIGNED_IN = {
  stdout:
    "Logged in (via Devin).\n\nCredentials:\n  File: /home/test/.local/share/devin/credentials.toml\n",
  code: 0,
};

describe("checkDevinProviderStatus", () => {
  it.effect(
    "lists a signed-in account's models, commands and skills, then deletes the probe session",
    () =>
      Effect.gen(function* () {
        const { snapshot, methods } = yield* check(SIGNED_IN);
        assert.equal(snapshot.status, "ready");
        assert.equal(snapshot.version, "3000.14.30821");
        assert.deepEqual(snapshot.auth, { status: "authenticated", label: "Devin account" });
        assert.deepEqual(
          snapshot.models.map((model) => [model.slug, model.name, model.isDefault === true]),
          [
            ["swe-2-high", "SWE-2", true],
            ["swe-2-flash-medium", "SWE-2 Flash", false],
            ["claude-opus-5-5-medium", "Claude Opus 5.5", false],
          ],
        );
        const optionIds = (slug: string) =>
          snapshot.models
            .find((model) => model.slug === slug)
            ?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id);
        // Thinking and speed choices describe only the model the session ran.
        assert.deepEqual(optionIds("swe-2-high"), ["mode", "thought_level", "speed"]);
        assert.deepEqual(optionIds("claude-opus-5-5-medium"), ["mode"]);
        assert.deepEqual(
          snapshot.slashCommands.map((command) => command.name),
          ["compact", "plan"],
        );
        assert.deepEqual(
          snapshot.skills.map((skill) => skill.name),
          ["file-pr"],
        );
        assert.deepEqual(methods, ["initialize", "session/new", "session/delete"]);
      }),
  );

  it.effect("asks for `devin auth login` when signed out, without opening a session", () =>
    Effect.gen(function* () {
      const { snapshot, invoked } = yield* check({ stdout: "Not logged in.\n", code: 1 });
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.include(snapshot.message ?? "", "devin auth login");
      assert.deepEqual(invoked, ["--version", "auth status"]);
    }),
  );

  it.effect("stays a warning when the session lists no models, so cached models are kept", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* check(SIGNED_IN, "fail");
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }),
  );
});
