// @effect-diagnostics nodeBuiltinImport:off - Lockfile comparison checks parsed integrity records without depending on YAML key order.
import * as NodeUtil from "node:util";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const strings = Schema.Record(Schema.String, Schema.String);
const objects = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown));
const dependencies = Schema.Record(
  Schema.String,
  Schema.Struct({ specifier: Schema.String, version: Schema.String }),
);
const Importer = Schema.Struct({
  dependencies: Schema.optional(dependencies),
  devDependencies: Schema.optional(dependencies),
  optionalDependencies: Schema.optional(dependencies),
});
const Lockfile = Schema.Struct({
  lockfileVersion: Schema.String,
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  catalogs: Schema.optional(Schema.Record(Schema.String, dependencies)),
  importers: Schema.Record(Schema.String, Importer),
  packages: objects,
  snapshots: objects,
  overrides: Schema.optional(strings),
  patchedDependencies: Schema.optional(strings),
});
const Manifest = Schema.Struct({
  dependencies: Schema.optional(strings),
  devDependencies: Schema.optional(strings),
});
const Configuration = Schema.Struct({
  overrides: Schema.optional(strings),
  patchedDependencies: Schema.optional(strings),
});
const decodeLockfile = Schema.decodeSync(fromYaml(Lockfile));
const encodeLockfile = Schema.encodeSync(fromYaml(Lockfile));
const decodeChildren = Schema.decodeUnknownSync(strings);
const decodeResolution = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));
const decodeConfiguration = Schema.decodeEffect(fromYaml(Configuration));

export class StageLockfileError extends Schema.TaggedError<StageLockfileError>()(
  "StageLockfileError",
  { reason: Schema.String },
) {
  override get message() {
    return `Staged dependencies must use the reviewed lockfile: ${this.reason}`;
  }
}

const isStageLockfileError = Schema.is(StageLockfileError);
const stageLockfileErrorFromCause = (cause: unknown) =>
  isStageLockfileError(cause)
    ? cause
    : new StageLockfileError({ reason: "invalid or stale dependency lockfile" });

function parseLockfile(source: string) {
  // pnpm 12 prefixes the workspace lockfile with a separate package-manager lock document.
  return decodeLockfile(
    source
      .split(/^---[\t ]*$/m)
      .filter((part) => part.trim())
      .at(-1) ?? "",
  );
}

export function createStageLockfile(
  source: string,
  manifest: typeof Manifest.Type,
  config: typeof Configuration.Type,
) {
  const lockfile = parseLockfile(source);
  const importers = ["apps/desktop", "apps/server"].flatMap((name) => {
    const importer = lockfile.importers[name];
    return importer ? [importer] : [];
  });
  const resolve = (requested: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(requested).map(([name, spec]) => {
        const specifier = config.overrides?.[name] ?? spec;
        const candidate = importers
          .flatMap((importer) => [
            importer.dependencies?.[name],
            importer.devDependencies?.[name],
            importer.optionalDependencies?.[name],
          ])
          .find(
            (entry) =>
              entry !== undefined &&
              (entry.specifier === specifier ||
                (entry.specifier === "catalog:" &&
                  lockfile.catalogs?.default?.[name]?.specifier === specifier)),
          );
        const platformSnapshots = Object.keys(lockfile.snapshots).filter(
          (key) => key === `${name}@${specifier}` || key.startsWith(`${name}@${specifier}(`),
        );
        const version =
          candidate?.version ??
          (platformSnapshots.length === 1
            ? platformSnapshots[0]!.slice(name.length + 1)
            : undefined);
        if (!version || !lockfile.snapshots[`${name}@${version}`]) {
          throw new StageLockfileError({ reason: `no reviewed resolution for ${name}` });
        }
        return [name, { specifier, version }];
      }),
    );
  const patches = Object.fromEntries(
    Object.keys(config.patchedDependencies ?? {}).map((key) => {
      const hash = lockfile.patchedDependencies?.[key];
      if (!hash) throw new StageLockfileError({ reason: `no reviewed patch for ${key}` });
      return [key, hash];
    }),
  );
  const importer = {
    dependencies: resolve(manifest.dependencies),
    devDependencies: resolve(manifest.devDependencies),
  };
  const pending = Object.entries({ ...importer.dependencies, ...importer.devDependencies }).map(
    ([name, entry]) => `${name}@${entry.version}`,
  );
  const snapshots: Record<string, (typeof lockfile.snapshots)[string]> = {};
  const packages: Record<string, (typeof lockfile.packages)[string]> = {};
  for (let snapshotKey = pending.pop(); snapshotKey !== undefined; snapshotKey = pending.pop()) {
    if (snapshots[snapshotKey]) continue;
    const snapshot = lockfile.snapshots[snapshotKey];
    const packageKey = snapshotKey.split("(", 1)[0]!;
    const entry = lockfile.packages[packageKey];
    if (!snapshot || !entry)
      throw new StageLockfileError({ reason: `missing reviewed snapshot ${snapshotKey}` });
    snapshots[snapshotKey] = snapshot;
    packages[packageKey] = entry;
    for (const kind of ["dependencies", "optionalDependencies"] as const) {
      const children = decodeChildren(snapshot[kind] ?? {});
      for (const [name, version] of Object.entries(children)) {
        const key = lockfile.snapshots[`${name}@${version}`] ? `${name}@${version}` : version;
        pending.push(key);
      }
    }
  }
  return encodeLockfile({
    ...lockfile,
    importers: { ".": importer },
    packages,
    snapshots,
    overrides: config.overrides ?? {},
    patchedDependencies: patches,
  });
}

export function assertStageLockfileIntegrity(source: string, staged: string) {
  const reviewed = parseLockfile(source);
  const lockfile = parseLockfile(staged);
  for (const [name, entry] of Object.entries(lockfile.packages)) {
    const expected = reviewed.packages[name]?.resolution;
    const resolution = decodeResolution(entry.resolution);
    if (
      typeof resolution.integrity !== "string" ||
      !/^sha(?:256|384|512)-/.test(resolution.integrity) ||
      !NodeUtil.isDeepStrictEqual(resolution, expected)
    ) {
      throw new StageLockfileError({ reason: `unreviewed package bytes for ${name}` });
    }
  }
}

export const prepareStageLockfile = Effect.fn("prepareStageLockfile")(function* (
  repoRoot: string,
  stageDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const source = yield* fs.readFileString(path.join(repoRoot, "pnpm-lock.yaml"));
  const manifest = yield* decodeManifest(
    yield* fs.readFileString(path.join(stageDir, "package.json")),
  );
  const config = yield* decodeConfiguration(
    yield* fs.readFileString(path.join(stageDir, "pnpm-workspace.yaml")),
  );
  const lockfilePath = path.join(stageDir, "pnpm-lock.yaml");
  yield* fs.writeFileString(
    lockfilePath,
    yield* Effect.try({
      try: () => createStageLockfile(source, manifest, config),
      catch: stageLockfileErrorFromCause,
    }),
  );
  // Recompute pnpm's config/peer checksums without scripts, then reject unreviewed package bytes.
  const command = yield* resolveSpawnCommand("vp", [
    "install",
    "--lockfile-only",
    "--ignore-scripts",
    "--no-frozen-lockfile",
  ]);
  const child = yield* spawner.spawn(
    ChildProcess.make(command.command, command.args, {
      cwd: stageDir,
      shell: command.shell,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (Number(yield* child.exitCode) !== 0) {
    return yield* new StageLockfileError({ reason: "lockfile preparation failed" });
  }
  const staged = yield* fs.readFileString(lockfilePath);
  yield* Effect.try({
    try: () => assertStageLockfileIntegrity(source, staged),
    catch: stageLockfileErrorFromCause,
  });
});
