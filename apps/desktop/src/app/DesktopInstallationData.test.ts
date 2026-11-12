import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as InstallationData from "./DesktopInstallationData.ts";

const dependencies = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-install-import-" });
  const source = path.join(home, ".t3", "userdata");
  const base = path.join(home, ".t3-fork");
  const target = path.join(base, "userdata");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.makeDirectory(target, { recursive: true });
  yield* fs.makeDirectory(path.join(source, "attachments"));
  yield* fs.makeDirectory(path.join(source, "secrets"));
  yield* fs.writeFileString(path.join(source, "attachments", "saved.txt"), "source attachment");
  yield* fs.writeFileString(path.join(source, "client-settings.json"), '{"theme":"dark"}');
  yield* fs.writeFileString(
    path.join(source, "settings.json"),
    '{"autoResumeLimitedThreads":true,"continueThreadsAfterServerUpdate":true,"theme":"dark"}',
  );
  yield* fs.writeFileString(path.join(source, "environment-id"), "source-environment");
  yield* fs.writeFileString(path.join(source, "server-owner.sqlite"), "source-only ownership");
  yield* fs.writeFileString(
    path.join(source, "secrets", "cloud-cli-oauth-token.bin"),
    "source cloud auth",
  );
  yield* fs.writeFileString(
    path.join(source, "secrets", "provider-auth-abc.bin"),
    "saved provider key",
  );
  yield* fs.writeFileString(path.join(target, "environment-id"), "fork-environment");
  yield* fs.writeFileString(
    path.join(target, "desktop-settings.json"),
    '{"updateChannel":"nightly"}',
  );
  yield* fs.writeFileString(path.join(target, "previous.txt"), "fork data before import");
  const database = new NodeSqlite.DatabaseSync(path.join(source, "statev2.sqlite"));
  yield* Effect.addFinalizer(() => Effect.sync(() => database.close()));
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE projection_projects (title TEXT);
    INSERT INTO projection_projects VALUES ('source project');
    CREATE TABLE auth_sessions (token TEXT PRIMARY KEY);
    INSERT INTO auth_sessions VALUES ('source session');
    CREATE TABLE session_child (token TEXT REFERENCES auth_sessions(token));
    INSERT INTO session_child VALUES ('source session');
    CREATE TABLE scheduled_tasks (enabled INTEGER, next_run_at TEXT);
    INSERT INTO scheduled_tasks VALUES (1, '2026-12-01');
    CREATE TABLE orchestration_v2_effect_outbox (status TEXT);
    CREATE TABLE orchestration_v2_projection_runs (
      status TEXT, run_id TEXT, thread_id TEXT, completed_at TEXT, ordinal INTEGER, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_threads (payload_json TEXT, thread_id TEXT DEFAULT 'thread');
    CREATE TABLE orchestration_v2_projection_provider_threads (status TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_sessions (status TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (status TEXT);
  `);
  const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.provide(
      DesktopEnvironment.layer({
        fork: true,
        homeDirectory: home,
        dirname: home,
        platform: "darwin",
        processArch: "arm64",
        appVersion: "0.1.8",
        appPath: home,
        isPackaged: true,
        resourcesPath: home,
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: base })),
        ),
      ),
    ),
  );
  const data = yield* InstallationData.make.pipe(
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
  );
  return { fs, path, home, base, source, target, database, environment, data };
});

it.effect(
  "copies WAL-backed data read-only, pauses automation, preserves fork identity, and restores the previous data",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const state = yield* f.data.getState;
      assert.equal(state.installations[0]?.directory, f.path.join(f.home, ".t3"));
      const profile = f.path.join("providers", "antigravity", "profile");
      for (const directory of ["config", "antigravity-cli"]) {
        const native = f.path.join(f.home, ".gemini", directory, "skills");
        const managed = f.path.join(f.source, profile, directory, "skills");
        yield* f.fs.makeDirectory(native, { recursive: true });
        yield* f.fs.writeFileString(f.path.join(native, "SKILL.md"), "native skill");
        yield* f.fs.makeDirectory(f.path.dirname(managed), { recursive: true });
        yield* f.fs.symlink(native, managed);
      }
      const ownedSkill = f.path.join("providers", "antigravity", "owned", "config", "skills");
      yield* f.fs.makeDirectory(f.path.join(f.source, ownedSkill), { recursive: true });
      yield* f.fs.writeFileString(f.path.join(f.source, ownedSkill, "SKILL.md"), "owned skill");
      f.database.exec(`
        INSERT INTO orchestration_v2_projection_runs VALUES
          ('failed', 'old-run', 'history', '2026-11-01T00:00:00Z', 1, '{}'),
          ('completed', 'new-run', 'history', '2026-11-02T00:00:00Z', 2, '{}');
        INSERT INTO orchestration_v2_projection_threads VALUES
          ('{"limitRecovery":{"autoResume":true,"runId":"old-run"}}', 'history');
        INSERT INTO orchestration_v2_projection_provider_sessions VALUES
          ('ready', '{}'), ('ready', '{"extensionStatuses":[]}');
      `);
      for (const [directory, token] of [
        [f.source, "source-connect-token"],
        [f.target, "fork-connect-token"],
      ] as const) {
        yield* f.fs.makeDirectory(f.path.join(directory, "clerk"));
        yield* f.fs.writeFileString(f.path.join(directory, "clerk", "clerk-tokens.json"), token);
        yield* f.fs.writeFileString(f.path.join(directory, "clerk-tokens.json"), token);
      }
      yield* f.fs.writeFileString(
        f.path.join(f.source, "clerk", "source-only.json"),
        "source only",
      );
      yield* f.data.prepare(f.source);
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.target, "previous.txt")),
        "fork data before import",
      );
      yield* f.data.applyPending;
      const copy = new NodeSqlite.DatabaseSync(f.path.join(f.target, "statev2.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          copy.prepare("SELECT title FROM projection_projects").get()?.title,
          "source project",
        );
        assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()?.count, 0);
        assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM session_child").get()?.count, 0);
        assert.equal(copy.prepare("SELECT enabled FROM scheduled_tasks").get()?.enabled, 0);
        assert.isNull(copy.prepare("SELECT next_run_at FROM scheduled_tasks").get()?.next_run_at);
      } finally {
        copy.close();
      }
      assert.equal(f.database.prepare("SELECT enabled FROM scheduled_tasks").get()?.enabled, 1);
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.target, "settings.json")),
        '{"autoResumeLimitedThreads":false,"continueThreadsAfterServerUpdate":false,"theme":"dark"}',
      );
      assert.include(
        yield* f.fs.readFileString(f.path.join(f.source, "settings.json")),
        '"autoResumeLimitedThreads":true',
      );
      assert.equal(
        f.database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()?.count,
        1,
      );
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.target, "attachments", "saved.txt")),
        "source attachment",
      );
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.target, "secrets", "provider-auth-abc.bin")),
        "saved provider key",
      );
      assert.isFalse(
        yield* f.fs.exists(f.path.join(f.target, "secrets", "cloud-cli-oauth-token.bin")),
      );
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.target, "environment-id")),
        "fork-environment",
      );
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.target, "desktop-settings.json")),
        '{"updateChannel":"nightly"}',
      );
      assert.isFalse(yield* f.fs.exists(f.path.join(f.target, "server-owner.sqlite")));
      for (const relative of ["clerk/clerk-tokens.json", "clerk-tokens.json"]) {
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.target, relative)),
          "fork-connect-token",
        );
        assert.equal(
          yield* f.fs.readFileString(f.path.join(f.source, relative)),
          "source-connect-token",
        );
      }
      assert.isFalse(yield* f.fs.exists(f.path.join(f.target, "clerk", "source-only.json")));
      for (const directory of ["config", "antigravity-cli"]) {
        assert.isFalse(yield* f.fs.exists(f.path.join(f.target, profile, directory, "skills")));
        assert.equal(
          yield* f.fs.readFileString(
            f.path.join(f.home, ".gemini", directory, "skills", "SKILL.md"),
          ),
          "native skill",
        );
      }
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.target, ownedSkill, "SKILL.md")),
        "owned skill",
      );
      const imported = yield* f.data.getState;
      assert.lengthOf(imported.backups, 1);
      yield* f.data.restore(imported.backups[0]!.id);
      yield* f.data.applyPending;
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.target, "previous.txt")),
        "fork data before import",
      );
      assert.isFalse(yield* f.fs.exists(f.path.join(f.target, "statev2.sqlite")));
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "refuses running sources, unfinished work, overlapping paths, and links outside source data",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const descriptor = f.path.join(f.source, "server-runtime.json");
      yield* f.fs.writeFileString(
        descriptor,
        JSON.stringify({ pid: process.pid, origin: "http://127.0.0.1:3773" }),
      );
      const running = yield* Effect.flip(f.data.prepare(f.source));
      assert.instanceOf(running, InstallationData.DesktopInstallationDataUnavailable);
      if (running._tag === "DesktopInstallationDataUnavailable")
        assert.equal(running.reason, "source-running");
      const state = yield* f.data.getState;
      assert.equal(state.installations[0]?.origin, "http://127.0.0.1:3773");
      yield* f.fs.remove(descriptor);
      f.database.exec("INSERT INTO orchestration_v2_effect_outbox VALUES ('pending')");
      const busy = yield* Effect.flip(f.data.prepare(f.source));
      if (busy._tag === "DesktopInstallationDataUnavailable")
        assert.equal(busy.reason, "source-busy");
      else assert.fail("Import should reject pending agent effects");
      assert.isFalse(yield* f.fs.exists(f.path.join(f.base, "pending-installation-import.json")));
      f.database.exec("DELETE FROM orchestration_v2_effect_outbox");
      f.database.exec(`INSERT INTO orchestration_v2_projection_runs VALUES
        ('failed', 'latest-run', 'thread', '2026-11-01T00:00:00Z', 1, '{}')`);
      for (const [table, values] of [
        [
          "orchestration_v2_projection_threads",
          ['{"limitRecovery":{"autoResume":true,"runId":"latest-run"}}', "thread"],
        ],
        ["orchestration_v2_projection_threads", ['{"pullRequests":[{"watch":{}}]}', "thread"]],
        ["orchestration_v2_projection_provider_threads", ["active", "{}"]],
        [
          "orchestration_v2_projection_provider_threads",
          ["idle", '{"pendingBackgroundTasks":[{}]}'],
        ],
        ["orchestration_v2_projection_provider_threads", ["idle", '{"goal":{"status":"active"}}']],
        ["orchestration_v2_projection_provider_sessions", ["starting", "{}"]],
        ["orchestration_v2_projection_provider_sessions", ["running", "{}"]],
        ["orchestration_v2_projection_provider_sessions", ["waiting", "{}"]],
        [
          "orchestration_v2_projection_provider_sessions",
          ["ready", '{"extensionStatuses":[{"key":"watch","text":"Watching"}]}'],
        ],
        ["orchestration_v2_projection_runtime_requests", ["pending"]],
        ["orchestration_v2_projection_runs", ["running", "busy-run", "thread", null, 2, "{}"]],
      ] as const) {
        f.database
          .prepare(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`)
          .run(...values);
        const recovery = yield* Effect.flip(f.data.prepare(f.source));
        if (recovery._tag === "DesktopInstallationDataUnavailable")
          assert.equal(recovery.reason, "source-busy");
        else assert.fail(`Import should reject resumable work in ${table}`);
        f.database.exec(`DELETE FROM ${table}`);
      }
      yield* f.fs.writeFileString(
        f.path.join(f.target, "state.sqlite"),
        "guarded by overlap validation",
      );
      const overlap = yield* Effect.flip(f.data.prepare(f.target));
      if (overlap._tag === "DesktopInstallationDataUnavailable")
        assert.equal(overlap.reason, "overlapping-paths");
      else assert.fail("Import should reject its own data");
      const external = f.path.join(f.home, "unrelated.txt");
      yield* f.fs.writeFileString(external, "not installation data");
      yield* f.fs.symlink(external, f.path.join(f.source, "outside-link"));
      const unsafe = yield* Effect.flip(f.data.prepare(f.source));
      if (unsafe._tag === "DesktopInstallationDataUnavailable")
        assert.equal(unsafe.reason, "unsafe-path");
      else assert.fail("Import should reject external links");
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.target, "previous.txt")),
        "fork data before import",
      );
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "rolls back a failed swap and resumes a committed import after interrupted marker cleanup",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.data.prepare(f.source);
      const failure = (file: string) =>
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "rename",
          pathOrDescriptor: file,
        });
      const brokenSwap = yield* InstallationData.make.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, f.environment),
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          rename: (from, to) =>
            from.includes("installation-imports")
              ? Effect.fail(failure(from))
              : f.fs.rename(from, to),
        }),
      );
      yield* Effect.flip(brokenSwap.applyPending);
      assert.equal(
        yield* f.fs.readFileString(f.path.join(f.target, "previous.txt")),
        "fork data before import",
      );
      const interruptedCleanup = yield* InstallationData.make.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, f.environment),
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          remove: (file, options) =>
            file.endsWith("pending-installation-import.json")
              ? Effect.fail(failure(file))
              : f.fs.remove(file, options),
        }),
      );
      yield* Effect.flip(interruptedCleanup.applyPending);
      assert.isTrue(yield* f.fs.exists(f.path.join(f.target, "statev2.sqlite")));
      yield* f.data.applyPending;
      assert.isFalse(yield* f.fs.exists(f.path.join(f.base, "pending-installation-import.json")));
      assert.lengthOf((yield* f.data.getState).backups, 1);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("rejects traversal backup ids and leaves non-fork installations unchanged", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const traversal = yield* Effect.flip(f.data.restore("../../userdata"));
    if (traversal._tag === "DesktopInstallationDataUnavailable")
      assert.equal(traversal.reason, "unsafe-path");
    else assert.fail("Restore should reject traversal");
    yield* f.fs.remove(f.target, { recursive: true });
    yield* f.fs.symlink(f.source, f.target);
    const aliased = yield* Effect.flip(f.data.prepare(f.source));
    if (aliased._tag === "DesktopInstallationDataUnavailable")
      assert.equal(aliased.reason, "unsafe-path");
    else assert.fail("Import must reject a fork userdata alias");
    yield* f.fs.remove(f.target);
    yield* f.fs.makeDirectory(f.target);
    yield* f.fs.writeFileString(f.path.join(f.target, "previous.txt"), "fork data before import");
    const official = yield* InstallationData.make.pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        ...f.environment,
        branding: { baseName: "T3 Code", stageLabel: "Nightly", displayName: "T3 Code (Nightly)" },
      }),
    );
    assert.isFalse((yield* official.getState).supported);
    const denied = yield* Effect.flip(official.prepare(f.source));
    if (denied._tag === "DesktopInstallationDataUnavailable")
      assert.equal(denied.reason, "fork-only");
    else assert.fail("Official installs should not expose fork imports");
    assert.equal(
      yield* f.fs.readFileString(f.path.join(f.target, "previous.txt")),
      "fork data before import",
    );
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
