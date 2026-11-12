import * as NodeSqlite from "node:sqlite";
import type { DesktopInstallationDataState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as PlatformError from "effect/PlatformError";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { desktopForkIdentity } from "../forkIdentity.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopInstallationDataError extends Schema.TaggedError<DesktopInstallationDataError>()(
  "DesktopInstallationDataError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not ${this.operation}. No changes were made to the source installation.`;
  }
}

export class DesktopInstallationDataUnavailable extends Schema.TaggedError<DesktopInstallationDataUnavailable>()(
  "DesktopInstallationDataUnavailable",
  {
    reason: Schema.Literals([
      "fork-only",
      "source-running",
      "target-running",
      "overlapping-paths",
      "source-missing",
      "source-busy",
      "unsafe-path",
      "pending-import",
    ]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "fork-only":
        return "Installation import is available only in T3 Code Fork.";
      case "source-running":
        return "Close the source T3 Code app before importing. Use Keep connected to share its live data instead.";
      case "target-running":
        return "The fork backend is still running. Close it before applying the import.";
      case "overlapping-paths":
        return "Choose a different installation. Source and destination data folders must not overlap.";
      case "source-missing":
        return "This folder does not contain a T3 Code database. Choose a T3 home folder or its userdata folder.";
      case "source-busy":
        return "The source has unfinished work, a PR watch, or automatic recovery enabled for a thread. Finish or stop it before importing, or use Keep connected.";
      case "unsafe-path":
        return "The import contains a link outside its data folder or an invalid backup path.";
      case "pending-import":
        return "An import is already ready. Restart the fork to finish it.";
    }
  }
}

type ImportError = DesktopInstallationDataError | DesktopInstallationDataUnavailable;

export class DesktopInstallationData extends Context.Service<
  DesktopInstallationData,
  {
    readonly getState: Effect.Effect<DesktopInstallationDataState, ImportError>;
    readonly prepare: (directory: string) => Effect.Effect<void, ImportError>;
    readonly restore: (backupId: string) => Effect.Effect<void, ImportError>;
    readonly applyPending: Effect.Effect<void, ImportError>;
  }
>()("@t3tools/desktop/app/DesktopInstallationData") {}

const Pending = Schema.fromJsonString(
  Schema.Struct({ kind: Schema.Literals(["import", "restore"]), id: Schema.String }),
);
const Backup = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, createdAt: Schema.String }),
);
const Runtime = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int, origin: Schema.optionalKey(Schema.String) }),
);
const isUnavailable = Schema.is(DesktopInstallationDataUnavailable);
const isImportError = Schema.is(DesktopInstallationDataError);
const encodePending = Schema.encodeEffect(Pending);
const decodePending = Schema.decodeEffect(Pending);
const encodeBackup = Schema.encodeEffect(Backup);
const decodeBackup = Schema.decodeEffect(Backup);
const decodeRuntime = Schema.decodeEffect(Runtime);
const Settings = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(Settings);
const encodeSettings = Schema.encodeEffect(Settings);
const validId = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const portableRootEntry = (name: string) =>
  ![
    "server-runtime.json",
    "server-owner.sqlite",
    "server-owner.sqlite-wal",
    "server-owner.sqlite-shm",
    "environment-id",
    "anonymous-id",
    "desktop-settings.json",
    "connection-catalog.json",
    "saved-environments.json",
    "clerk",
    "clerk-tokens.json",
    "statev2.sqlite",
    "state.sqlite",
    "statev2.sqlite-wal",
    "statev2.sqlite-shm",
    "state.sqlite-wal",
    "state.sqlite-shm",
  ].includes(name) && !name.startsWith(".v2-import-");

const localOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
};

const processAlive = (pid: number) => {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
};

const snapshotDatabase = Effect.fn("desktop.installationData.snapshotDatabase")(function* (
  source: string,
  destination: string,
) {
  yield* Effect.tryPromise({
    try: async () => {
      const reader = new NodeSqlite.DatabaseSync(source, { readOnly: true });
      try {
        await NodeSqlite.backup(reader, destination);
      } finally {
        reader.close();
      }
      const copy = new NodeSqlite.DatabaseSync(destination);
      try {
        const tables = new Set(
          copy
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((row) => String(row.name)),
        );
        if (!tables.has("projection_projects"))
          throw new DesktopInstallationDataUnavailable({ reason: "source-missing" });
        if (String(copy.prepare("PRAGMA quick_check").get()?.quick_check) !== "ok")
          throw new Error("Invalid database snapshot");
        for (const [table, condition] of [
          ["orchestration_v2_effect_outbox", "status IN ('pending', 'running')"],
          [
            "orchestration_v2_projection_runs",
            "status IN ('preparing', 'queued', 'starting', 'running', 'waiting')",
          ],
          ["orchestration_v2_projection_runtime_requests", "status = 'pending'"],
          [
            "orchestration_v2_projection_provider_sessions",
            "status NOT IN ('ready', 'stopped', 'error') OR (json_valid(payload_json) AND json_array_length(payload_json, '$.extensionStatuses') > 0)",
          ],
          [
            "orchestration_v2_projection_provider_threads",
            "status = 'active' OR (json_valid(payload_json) AND (json_array_length(payload_json, '$.pendingBackgroundTasks') > 0 OR json_extract(payload_json, '$.goal.status') = 'active'))",
          ],
          [
            "orchestration_v2_projection_threads",
            `json_valid(payload_json) AND (
              EXISTS (SELECT 1 FROM json_each(payload_json, '$.pullRequests') AS link
                WHERE json_type(link.value, '$.watch') = 'object')
              OR (json_extract(payload_json, '$.limitRecovery.autoResume') = 1
                AND json_extract(payload_json, '$.limitRecovery.runId') = (
                  SELECT latest.run_id FROM orchestration_v2_projection_runs latest
                  WHERE latest.thread_id = orchestration_v2_projection_threads.thread_id
                    AND latest.status <> 'queued'
                    AND NOT (latest.status = 'cancelled'
                      AND json_extract(latest.payload_json, '$.startedAt') IS NULL)
                  ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
                    latest.ordinal DESC, latest.run_id DESC
                  LIMIT 1
                ))
            )`,
          ],
        ] as const) {
          if (
            tables.has(table) &&
            Number(
              copy.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE ${condition}`).get()
                ?.count,
            ) > 0
          ) {
            throw new DesktopInstallationDataUnavailable({ reason: "source-busy" });
          }
        }
        const cleared = new Set([
          "auth_sessions",
          "auth_pairing_links",
          "peer_environment_links",
          "provider_session_runtime",
        ]);
        for (let changed = true; changed;) {
          changed = false;
          for (const table of tables) {
            if (cleared.has(table)) continue;
            if (
              copy
                .prepare(`PRAGMA foreign_key_list("${table.replaceAll('"', '""')}")`)
                .all()
                .some((row) => cleared.has(String(row.table)))
            ) {
              cleared.add(table);
              changed = true;
            }
          }
        }
        copy.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
        for (const table of cleared)
          if (tables.has(table)) copy.exec(`DELETE FROM "${table.replaceAll('"', '""')}"`);
        if (tables.has("scheduled_tasks"))
          copy.exec("UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL");
        copy.exec("COMMIT");
      } finally {
        copy.close();
      }
    },
    catch: (cause) =>
      isUnavailable(cause)
        ? cause
        : new DesktopInstallationDataError({ operation: "snapshot the database", cause }),
  });
});

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const mutex = yield* Semaphore.make(1);
  const supported = environment.branding.baseName === desktopForkIdentity.baseName;
  const pendingPath = path.join(environment.baseDir, "pending-installation-import.json");
  const stageRoot = path.join(environment.baseDir, "installation-imports");
  const backupRoot = path.join(environment.baseDir, "installation-backups");
  const guard = supported
    ? Effect.void
    : Effect.fail(new DesktopInstallationDataUnavailable({ reason: "fork-only" }));
  const wrap = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isUnavailable(cause) || isImportError(cause)
          ? cause
          : new DesktopInstallationDataError({ operation, cause }),
      ),
    );
  const runtime = Effect.fn("desktop.installationData.runtime")(function* (directory: string) {
    return yield* fs.readFileString(path.join(directory, "server-runtime.json")).pipe(
      Effect.flatMap(decodeRuntime),
      Effect.orElseSucceed(() => null),
    );
  });
  const assertStopped = Effect.fn("desktop.installationData.assertStopped")(function* (
    directory: string,
    target = false,
  ) {
    const state = yield* runtime(directory);
    if (state && processAlive(state.pid))
      return yield* new DesktopInstallationDataUnavailable({
        reason: target ? "target-running" : "source-running",
      });
  });
  const assertNoPending = Effect.fn("desktop.installationData.assertNoPending")(function* () {
    if (yield* fs.exists(pendingPath))
      return yield* new DesktopInstallationDataUnavailable({ reason: "pending-import" });
  });
  const resolveSource = Effect.fn("desktop.installationData.resolveSource")(function* (
    directory: string,
  ) {
    const source = path.resolve(directory);
    if (
      (yield* fs.exists(path.join(source, "statev2.sqlite"))) ||
      (yield* fs.exists(path.join(source, "state.sqlite")))
    )
      return source;
    if (
      (yield* fs.exists(path.join(source, "userdata", "statev2.sqlite"))) ||
      (yield* fs.exists(path.join(source, "userdata", "state.sqlite")))
    )
      return path.join(source, "userdata");
    return yield* new DesktopInstallationDataUnavailable({ reason: "source-missing" });
  });
  const writePending = Effect.fn("desktop.installationData.writePending")(function* (
    kind: "import" | "restore",
    id: string,
  ) {
    const temporary = `${pendingPath}.${yield* random.uuidV4()}.tmp`;
    yield* fs
      .writeFileString(temporary, yield* encodePending({ kind, id }), { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.andThen(fs.link(temporary, pendingPath)),
        Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
      );
  });
  const assertOwnStateDirectory = Effect.fn("desktop.installationData.assertOwnStateDirectory")(
    function* () {
      if (!(yield* fs.exists(environment.stateDir))) return;
      const expected = path.join(
        yield* fs.realPath(environment.baseDir),
        path.relative(environment.baseDir, environment.stateDir),
      );
      if ((yield* fs.realPath(environment.stateDir)) !== expected)
        return yield* new DesktopInstallationDataUnavailable({ reason: "unsafe-path" });
    },
  );
  const copyPortableTree = Effect.fn("desktop.installationData.copyPortableTree")(function* (
    source: string,
    destination: string,
    root: string,
    ancestors: ReadonlySet<string> = new Set(),
  ): Effect.fn.Return<void, PlatformError.PlatformError | DesktopInstallationDataUnavailable> {
    const relative = path.relative(root, source).split(path.sep);
    // Antigravity recreates links to native skill directories when preparing its profile.
    if (
      relative.length === 5 &&
      relative[0] === "providers" &&
      relative[1] === "antigravity" &&
      (relative[3] === "config" || relative[3] === "antigravity-cli") &&
      relative[4] === "skills" &&
      (yield* fs.readLink(source).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ))
    )
      return;
    const real = yield* fs.realPath(source);
    if ((real !== root && !real.startsWith(root + path.sep)) || ancestors.has(real))
      return yield* new DesktopInstallationDataUnavailable({ reason: "unsafe-path" });
    const info = yield* fs.stat(real);
    if (info.type === "Directory") {
      yield* fs.makeDirectory(destination, { recursive: true, mode: 0o700 });
      for (const name of yield* fs.readDirectory(real)) {
        if (
          real === path.join(root, "secrets") &&
          (name === "files" ||
            name.startsWith("cloud-") ||
            name.includes("signing-key") ||
            name.startsWith("dpop-") ||
            name.startsWith("mcp-oauth-"))
        )
          continue;
        if (["SingletonLock", "SingletonSocket", "SingletonCookie"].includes(name)) continue;
        yield* copyPortableTree(
          path.join(real, name),
          path.join(destination, name),
          root,
          new Set([...ancestors, real]),
        );
      }
    } else if (info.type === "File") {
      yield* fs.copyFile(real, destination);
      yield* fs.chmod(destination, 0o600);
    }
  });

  const prepare = Effect.fn("desktop.installationData.prepare")(function* (directory: string) {
    yield* guard;
    yield* assertNoPending();
    const source = yield* fs.realPath(yield* resolveSource(directory));
    yield* fs.makeDirectory(environment.baseDir, { recursive: true, mode: 0o700 });
    const base = yield* fs.realPath(environment.baseDir);
    if (source === base || source.startsWith(base + path.sep) || base.startsWith(source + path.sep))
      return yield* new DesktopInstallationDataUnavailable({ reason: "overlapping-paths" });
    yield* assertOwnStateDirectory();
    yield* assertStopped(source);
    const id = yield* random.uuidV4();
    const stage = path.join(stageRoot, id);
    yield* fs.makeDirectory(stage, { recursive: true, mode: 0o700 });
    yield* Effect.gen(function* () {
      for (const name of yield* fs.readDirectory(source))
        if (portableRootEntry(name))
          yield* copyPortableTree(path.join(source, name), path.join(stage, name), source);
      for (const name of ["statev2.sqlite", "state.sqlite"]) {
        if (yield* fs.exists(path.join(source, name))) {
          const real = yield* fs.realPath(path.join(source, name));
          if (!real.startsWith(source + path.sep))
            return yield* new DesktopInstallationDataUnavailable({ reason: "unsafe-path" });
          yield* snapshotDatabase(real, path.join(stage, name));
          yield* fs.chmod(path.join(stage, name), 0o600);
        }
      }
      const settingsPath = path.join(stage, "settings.json");
      if (yield* fs.exists(settingsPath)) {
        const settings = yield* fs
          .readFileString(settingsPath)
          .pipe(Effect.flatMap(decodeSettings));
        yield* fs.writeFileString(
          settingsPath,
          yield* encodeSettings({
            ...settings,
            autoResumeLimitedThreads: false,
            continueThreadsAfterServerUpdate: false,
          }),
        );
      }
      if (yield* fs.exists(environment.stateDir)) {
        const ownState = yield* fs.realPath(environment.stateDir);
        for (const name of [
          "desktop-settings.json",
          "environment-id",
          "anonymous-id",
          "connection-catalog.json",
          "saved-environments.json",
          "clerk",
          "clerk-tokens.json",
        ]) {
          const current = path.join(ownState, name);
          if (yield* fs.exists(current))
            yield* copyPortableTree(current, path.join(stage, name), ownState);
        }
      }
      yield* assertStopped(source);
      yield* writePending("import", id);
    }).pipe(
      Effect.onError(() => fs.remove(stage, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
  });

  const restore = Effect.fn("desktop.installationData.restore")(function* (backupId: string) {
    yield* guard;
    yield* assertNoPending();
    if (!validId(backupId) || !(yield* fs.exists(path.join(backupRoot, backupId, "userdata"))))
      return yield* new DesktopInstallationDataUnavailable({ reason: "unsafe-path" });
    yield* writePending("restore", backupId);
  });

  const applyPending = Effect.gen(function* () {
    if (!supported || !(yield* fs.exists(pendingPath))) return;
    const pending = yield* fs.readFileString(pendingPath).pipe(Effect.flatMap(decodePending));
    if (!validId(pending.id))
      return yield* new DesktopInstallationDataUnavailable({ reason: "unsafe-path" });
    const marker = path.join(environment.stateDir, ".fork-installation-import");
    if (
      (yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""))) ===
      `${pending.kind}:${pending.id}`
    ) {
      yield* fs.remove(pendingPath);
      return;
    }
    const incoming =
      pending.kind === "import"
        ? path.join(stageRoot, pending.id)
        : path.join(backupRoot, pending.id, "userdata");
    const real = yield* fs.realPath(incoming);
    if (
      real !==
      path.join(
        yield* fs.realPath(environment.baseDir),
        pending.kind === "import" ? "installation-imports" : "installation-backups",
        pending.id,
        ...(pending.kind === "restore" ? ["userdata"] : []),
      )
    )
      return yield* new DesktopInstallationDataUnavailable({ reason: "unsafe-path" });
    yield* assertOwnStateDirectory();
    yield* assertStopped(environment.stateDir, true);
    yield* fs.writeFileString(
      path.join(incoming, ".fork-installation-import"),
      `${pending.kind}:${pending.id}`,
      { mode: 0o600 },
    );
    const id = yield* random.uuidV4();
    const backup = path.join(backupRoot, id);
    yield* fs.makeDirectory(backup, { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(
      path.join(backup, "backup.json"),
      yield* encodeBackup({
        id,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      }),
      { mode: 0o600 },
    );
    const existed = yield* fs.exists(environment.stateDir);
    if (existed) yield* fs.rename(environment.stateDir, path.join(backup, "userdata"));
    yield* fs
      .rename(incoming, environment.stateDir)
      .pipe(
        Effect.onError(() =>
          existed
            ? fs.rename(path.join(backup, "userdata"), environment.stateDir).pipe(Effect.orDie)
            : Effect.void,
        ),
      );
    yield* fs.remove(pendingPath);
  }).pipe(Effect.withSpan("desktop.installationData.applyPending"));

  const getState = Effect.gen(function* () {
    if (!supported) return { supported, installations: [], backups: [] };
    const installations: Array<DesktopInstallationDataState["installations"][number]> = [];
    for (const name of [".t3", ".t3-nightly", ".t3-alpha"]) {
      const directory = path.join(environment.homeDirectory, name);
      const source = yield* resolveSource(directory).pipe(Effect.orElseSucceed(() => null));
      if (!source || path.resolve(directory) === path.resolve(environment.baseDir)) continue;
      const state = yield* runtime(source);
      const running = state !== null && processAlive(state.pid);
      let origin: string | null = null;
      if (running && state.origin) origin = localOrigin(state.origin);
      installations.push({
        directory,
        label: name === ".t3" ? "T3 Code" : `T3 Code ${name.slice(4)}`,
        running,
        origin,
      });
    }
    const backups: Array<DesktopInstallationDataState["backups"][number]> = [];
    if (yield* fs.exists(backupRoot))
      for (const id of yield* fs.readDirectory(backupRoot)) {
        if (!validId(id) || !(yield* fs.exists(path.join(backupRoot, id, "userdata")))) continue;
        const record = yield* fs.readFileString(path.join(backupRoot, id, "backup.json")).pipe(
          Effect.flatMap(decodeBackup),
          Effect.orElseSucceed(() => null),
        );
        if (record?.id === id) backups.push(record);
      }
    return {
      supported,
      installations,
      backups: backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }).pipe(Effect.withSpan("desktop.installationData.getState"));
  return DesktopInstallationData.of({
    getState: wrap("inspect installations", getState),
    prepare: Effect.fn("desktop.installationData.requestImport")((directory: string) =>
      wrap("prepare the import", mutex.withPermits(1)(prepare(directory))),
    ),
    restore: Effect.fn("desktop.installationData.requestRestore")((id: string) =>
      wrap("prepare the restore", mutex.withPermits(1)(restore(id))),
    ),
    applyPending: wrap("apply the import", applyPending),
  });
});

export const layer = Layer.effect(DesktopInstallationData, make);
