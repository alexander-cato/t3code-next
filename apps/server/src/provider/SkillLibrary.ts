import {
  ProviderDriverKind,
  type ProviderInstanceId,
  SkillLibraryError,
  type SkillLibraryEntry,
  type SkillLibraryMutation,
  type SkillLibrarySnapshot,
  type SkillName,
  type SkillSource,
  type SkillSourcePreview,
  type SkillTarget,
  type SkillTargetId,
  type SkillTargetState,
  type SkillUpdateCheck,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { parseSkillFrontmatter } from "./Drivers/ClaudeSkills.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { backUpCatalog } from "./skillLibraryBackup.ts";
import {
  closestScenario,
  EMPTY_MANIFEST,
  MANIFEST_FILE,
  readManifest,
  readSkillsManagerExport,
  withScenarioTarget,
  writeManifest,
  type ScenarioSkills,
  type SkillManifest,
} from "./skillLibraryManifest.ts";
import {
  findSkillFolders,
  parseSkillSourceUrl,
  sameSkillFiles,
  sourceKey,
} from "./skillLibrarySources.ts";

const MAX_SKILL_FILE_BYTES = 1_000_000;
const CLONE_TIMEOUT_MS = 120_000;
/** Lets a burst of toggles land in one backup commit. */
const BACKUP_DELAY = "30 seconds";
const MAINTENANCE_START_DELAY = "5 minutes";
const MAINTENANCE_INTERVAL = "12 hours";
const isSkillName = Schema.is(
  Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
);

type Locations = {
  readonly path: Path.Path;
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
};
type TargetSpec = {
  readonly id: SkillTargetId;
  readonly displayName: string;
  readonly driver?: ProviderDriverKind;
  /** The ACP Registry agent that runs this tool in T3 Code. */
  readonly acpRegistryAgent?: string;
  /** The tool's config folder; the target shows when it exists or the provider is set up. */
  readonly home: (locations: Locations) => string;
  /** The folder the tool reads user skills from. */
  readonly directory?: (locations: Locations) => string;
};

const fromEnv = (environment: NodeJS.ProcessEnv, name: string) =>
  environment[name]?.trim() || undefined;
const homeDir =
  (...segments: string[]) =>
  ({ path, home }: Locations) =>
    path.join(home, ...segments);

/** User skill folders, with the ids skills-manager.app uses so its scenarios import as they are. */
const TARGET_SPECS: ReadonlyArray<TargetSpec> = [
  {
    id: "claude_code" as SkillTargetId,
    displayName: "Claude",
    driver: ProviderDriverKind.make("claudeAgent"),
    home: ({ path, home, environment }) =>
      fromEnv(environment, "CLAUDE_CONFIG_DIR") ?? path.join(home, ".claude"),
  },
  {
    id: "codex" as SkillTargetId,
    displayName: "Codex",
    driver: ProviderDriverKind.make("codex"),
    home: ({ path, home, environment }) =>
      fromEnv(environment, "CODEX_HOME") ?? path.join(home, ".codex"),
  },
  {
    id: "cursor" as SkillTargetId,
    displayName: "Cursor",
    driver: ProviderDriverKind.make("cursor"),
    home: homeDir(".cursor"),
  },
  {
    id: "opencode" as SkillTargetId,
    displayName: "OpenCode",
    driver: ProviderDriverKind.make("opencode"),
    home: ({ path, home, environment }) =>
      path.join(fromEnv(environment, "XDG_CONFIG_HOME") ?? path.join(home, ".config"), "opencode"),
  },
  {
    id: "pi" as SkillTargetId,
    displayName: "Pi",
    driver: ProviderDriverKind.make("pi"),
    home: homeDir(".pi", "agent"),
  },
  {
    id: "antigravity" as SkillTargetId,
    displayName: "Antigravity",
    driver: ProviderDriverKind.make("antigravity"),
    home: homeDir(".gemini", "config"),
  },
  {
    id: "kiro" as SkillTargetId,
    displayName: "Kiro",
    driver: ProviderDriverKind.make("kiro"),
    home: homeDir(".kiro"),
  },
  {
    id: "grok" as SkillTargetId,
    displayName: "Grok",
    driver: ProviderDriverKind.make("grok"),
    home: homeDir(".grok"),
  },
  {
    id: "devin" as SkillTargetId,
    displayName: "Devin",
    driver: ProviderDriverKind.make("devin"),
    acpRegistryAgent: "devin",
    home: homeDir(".config", "devin"),
  },
  { id: "gemini_cli" as SkillTargetId, displayName: "Gemini CLI", home: homeDir(".gemini") },
  { id: "github_copilot" as SkillTargetId, displayName: "Copilot", home: homeDir(".copilot") },
  { id: "goose" as SkillTargetId, displayName: "Goose", home: homeDir(".config", "goose") },
  { id: "junie" as SkillTargetId, displayName: "Junie", home: homeDir(".junie") },
  { id: "omp_agent" as SkillTargetId, displayName: "omp", home: homeDir(".omp", "agent") },
  {
    id: "warp" as SkillTargetId,
    displayName: "Warp",
    home: homeDir(".warp"),
    directory: homeDir(".agents", "skills"),
  },
  {
    id: "windsurf" as SkillTargetId,
    displayName: "Windsurf",
    home: homeDir(".codeium", "windsurf"),
  },
];
const KNOWN_TARGET_IDS: ReadonlySet<string> = new Set(TARGET_SPECS.map((spec) => spec.id));
/** Tools skills-manager.app does not manage, so its scenarios say nothing about them. */
const OUTSIDE_SKILLS_MANAGER: ReadonlySet<string> = new Set(["devin"]);

/** What a target folder holds under a skill's name: T3's link to the catalog, or anything else. */
type TargetEntry = { readonly kind: "link" } | { readonly kind: "own"; readonly path: string };

type Scan = SkillLibrarySnapshot & {
  readonly manifest: SkillManifest;
  readonly hasManifest: boolean;
  /** Provider instances that run each target's tool, refreshed when its skills change. */
  readonly instances: ReadonlyMap<string, ReadonlyArray<ProviderInstanceId>>;
};

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");
const isAcpRegistryConfig = Schema.is(Schema.Struct({ agentId: Schema.String }));

export class SkillLibrary extends Context.Service<
  SkillLibrary,
  {
    readonly list: Effect.Effect<SkillLibrarySnapshot, SkillLibraryError>;
    readonly previewSource: (url: string) => Effect.Effect<SkillSourcePreview, SkillLibraryError>;
    readonly mutate: (
      mutation: SkillLibraryMutation,
    ) => Effect.Effect<SkillLibrarySnapshot, SkillLibraryError>;
  }
>()("t3/provider/SkillLibrary") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettingsService;
  const layerScope = yield* Effect.scope;
  const mutations = yield* Semaphore.make(1);
  const updateChecks = new Map<string, SkillUpdateCheck>();
  let updatesCheckedAt: string | undefined;
  let backupStatus: { readonly lastBackupAt?: string; readonly error?: string } = {};
  let backupGeneration = 0;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // The file helpers read these from context; the service already holds them.
  const withPlatform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const fail = (reason: SkillLibraryError["reason"], detail: string) =>
    new SkillLibraryError({ reason, detail });
  const filesystemError = (detail: string) => (cause: unknown) =>
    fail("filesystem-error", `${detail}${cause instanceof Error ? `: ${cause.message}` : ""}`);
  const notFound = (name: string) => fail("not-found", `No skill named '${name}'.`);

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  const locate = Effect.gen(function* () {
    const locations: Locations = {
      path,
      home: yield* HostProcess.HomeDirectory,
      environment: yield* HostProcess.Environment,
    };
    const configured = new Set((yield* providerRegistry.getProviders).map((p) => p.driver));
    const registryInstances = new Map<string, ProviderInstanceId[]>();
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    for (const [instanceId, instance] of Object.entries(
      Option.match(settings, { onNone: () => ({}), onSome: (value) => value.providerInstances }),
    )) {
      if (instance.driver !== ACP_REGISTRY_DRIVER || instance.enabled === false) continue;
      if (!isAcpRegistryConfig(instance.config)) continue;
      const ids = registryInstances.get(instance.config.agentId) ?? [];
      registryInstances.set(instance.config.agentId, [...ids, instanceId as ProviderInstanceId]);
    }
    const targets: SkillTarget[] = [];
    const instances = new Map<string, ReadonlyArray<ProviderInstanceId>>();
    for (const spec of TARGET_SPECS) {
      const home = spec.home(locations);
      const runBy = spec.acpRegistryAgent
        ? (registryInstances.get(spec.acpRegistryAgent) ?? [])
        : [];
      const isProvider = (spec.driver && configured.has(spec.driver)) || runBy.length > 0;
      if (!isProvider && !(yield* exists(home))) continue;
      if (runBy.length > 0) instances.set(spec.id, runBy);
      targets.push({
        id: spec.id,
        displayName: spec.displayName,
        directory: spec.directory?.(locations) ?? path.join(home, "skills"),
        ...(spec.driver ? { driver: spec.driver } : {}),
      });
    }
    return {
      catalog: path.join(locations.home, ".agents", "skills", "skills"),
      targets,
      instances,
    };
  });

  const listNames = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(
      Effect.map((names) => names.filter(isSkillName).toSorted()),
      Effect.orElseSucceed((): string[] => []),
    );

  const isSkillDirectory = (directory: string) =>
    fileSystem.stat(path.join(directory, "SKILL.md")).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );

  // Untraced: one call per directory entry, inside the scan's span.
  const classifyEntry = Effect.fnUntraced(function* (
    directory: string,
    name: string,
    catalog: string,
  ) {
    const entryPath = path.join(directory, name);
    const link = yield* fileSystem.readLink(entryPath).pipe(Effect.option);
    if (Option.isSome(link) && path.resolve(directory, link.value) === path.join(catalog, name)) {
      return Option.some<TargetEntry>({ kind: "link" });
    }
    return (yield* isSkillDirectory(entryPath))
      ? Option.some<TargetEntry>({ kind: "own", path: entryPath })
      : Option.none<TargetEntry>();
  });

  const readDescription = Effect.fnUntraced(function* (directory: string) {
    const file = path.join(directory, "SKILL.md");
    const info = yield* fileSystem.stat(file).pipe(Effect.option);
    if (Option.isNone(info) || Number(info.value.size) > MAX_SKILL_FILE_BYTES) return undefined;
    const contents = yield* fileSystem.readFileString(file).pipe(Effect.option);
    if (Option.isNone(contents)) return undefined;
    const frontmatter = parseSkillFrontmatter(contents.value);
    return frontmatter.kind === "parsed" ? frontmatter.description : undefined;
  });

  const scan = Effect.fn("SkillLibrary.scan")(function* () {
    const { catalog, targets, instances } = yield* locate;
    const manifestOption = yield* readManifest(catalog);
    const manifest = Option.getOrElse(manifestOption, () => EMPTY_MANIFEST);

    const catalogNames = new Set<string>();
    for (const name of yield* listNames(catalog)) {
      if (yield* isSkillDirectory(path.join(catalog, name))) catalogNames.add(name);
    }

    const targetEntries = new Map<string, Map<string, TargetEntry>>();
    for (const target of targets) {
      const entries = new Map<string, TargetEntry>();
      for (const name of yield* listNames(target.directory)) {
        const entry = yield* classifyEntry(target.directory, name, catalog);
        if (Option.isSome(entry)) entries.set(name, entry.value);
      }
      targetEntries.set(target.id, entries);
    }

    const names = new Set(catalogNames);
    for (const entries of targetEntries.values())
      for (const name of entries.keys()) names.add(name);

    const skills: SkillLibraryEntry[] = [];
    for (const name of [...names].toSorted()) {
      const catalogPath = catalogNames.has(name) ? path.join(catalog, name) : undefined;
      const states: Record<SkillTargetId, SkillTargetState> = {};
      let descriptionSource = catalogPath;
      for (const target of targets) {
        const entry = targetEntries.get(target.id)?.get(name);
        states[target.id] =
          entry === undefined ? "off" : entry.kind === "link" ? "linked" : "external";
        if (descriptionSource === undefined && entry?.kind === "own")
          descriptionSource = entry.path;
      }
      const description =
        descriptionSource === undefined ? undefined : yield* readDescription(descriptionSource);
      const source = catalogPath ? manifest.sources[name] : undefined;
      const update = source ? updateChecks.get(name) : undefined;
      skills.push({
        name: name as SkillName,
        ...(description ? { description } : {}),
        ...(catalogPath ? { catalogPath } : {}),
        ...(source ? { source } : {}),
        ...(update ? { update } : {}),
        targets: states,
      });
    }

    const hasManifest = Option.isSome(manifestOption);
    const isRepository = yield* exists(path.join(catalog, ".git"));
    return {
      catalogDirectory: catalog,
      targets,
      skills,
      scenarios: Object.entries(manifest.scenarios).map(([name, scenario]) => ({
        name,
        skillCount: Object.keys(scenario).length,
      })),
      activeScenario: manifest.activeScenario,
      canImportSkillsManager:
        !hasManifest && (yield* exists(path.join(catalog, ".skills-manager", "skills"))),
      ...(updatesCheckedAt ? { updatesCheckedAt } : {}),
      backup: isRepository ? { enabled: manifest.autoBackup === true, ...backupStatus } : null,
      manifest,
      hasManifest,
      instances,
    } satisfies Scan;
  });

  const toSnapshot = ({
    manifest: _manifest,
    hasManifest: _hasManifest,
    instances: _instances,
    ...snapshot
  }: Scan) => snapshot satisfies SkillLibrarySnapshot;

  const linkedSkills = (snapshot: Scan): ScenarioSkills =>
    Object.fromEntries(
      snapshot.skills.flatMap((skill) => {
        const linked = snapshot.targets
          .filter((target) => skill.targets[target.id] === "linked")
          .map((target) => target.id);
        return linked.length === 0 ? [] : [[skill.name, linked]];
      }),
    );

  // Tools that are providers rescan in the background; the caller already has the new snapshot.
  const refreshChangedProviders = (before: Scan, after: Scan) => {
    const stateOf = (snapshot: Scan, target: SkillTargetId) =>
      JSON.stringify(snapshot.skills.map((skill) => [skill.name, skill.targets[target]]));
    const changed = after.targets.filter(
      (target) => stateOf(before, target.id) !== stateOf(after, target.id),
    );
    const drivers = new Set(changed.flatMap((target) => (target.driver ? [target.driver] : [])));
    const instances = new Set(changed.flatMap((target) => after.instances.get(target.id) ?? []));
    return Effect.all(
      [
        Effect.forEach(drivers, (driver) => providerRegistry.refresh(driver), { discard: true }),
        Effect.forEach(instances, (id) => providerRegistry.refreshInstance(id), { discard: true }),
      ],
      { discard: true },
    ).pipe(Effect.forkIn(layerScope), Effect.asVoid);
  };

  const saveManifest = (catalog: string, manifest: SkillManifest) =>
    writeManifest(catalog, manifest).pipe(
      Effect.mapError(filesystemError(`Could not save ${path.join(catalog, MANIFEST_FILE)}`)),
    );

  const link = (snapshot: Scan, name: string, target: SkillTarget) =>
    fileSystem
      .makeDirectory(target.directory, { recursive: true })
      .pipe(
        Effect.andThen(
          fileSystem.symlink(
            path.join(snapshot.catalogDirectory, name),
            path.join(target.directory, name),
          ),
        ),
        Effect.mapError(filesystemError(`Could not link ${name} into ${target.directory}`)),
      );
  const unlink = (name: string, target: SkillTarget) =>
    fileSystem
      .remove(path.join(target.directory, name))
      .pipe(Effect.mapError(filesystemError(`Could not remove ${target.directory}/${name}`)));

  /** Shallow-clones a source into a scoped temporary folder. */
  const cloneSource = Effect.fn("SkillLibrary.cloneSource")(function* (source: SkillSource) {
    const directory = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-skill-source-" })
      .pipe(Effect.mapError(filesystemError("Could not create a temporary folder")));
    const checkout = path.join(directory, "repo");
    yield* git
      .execute({
        operation: "SkillLibrary.cloneSource",
        cwd: directory,
        args: [
          "clone",
          "--depth",
          "1",
          ...(source.ref ? ["--branch", source.ref] : []),
          "--",
          source.repository,
          "repo",
        ],
        timeoutMs: CLONE_TIMEOUT_MS,
        env: { GIT_TERMINAL_PROMPT: "0", LANGUAGE: "C" },
      })
      .pipe(
        Effect.mapError((error) =>
          fail("git-error", `Could not fetch ${source.repository}: ${error.message}`),
        ),
      );
    return checkout;
  });

  const sourceFolder = (checkout: string, relative: string | undefined) => {
    const folder = path.resolve(checkout, relative ?? ".");
    return folder === checkout || folder.startsWith(`${checkout}${path.sep}`)
      ? Effect.succeed(folder)
      : Effect.fail(fail("invalid-source", `'${relative}' is outside the repository.`));
  };

  const previewIn = Effect.fn("SkillLibrary.previewIn")(function* (
    source: SkillSource,
    checkout: string,
    catalogNames: ReadonlySet<string>,
  ) {
    const base = yield* sourceFolder(checkout, source.path);
    const folders = yield* findSkillFolders(checkout, base);
    const repositoryName =
      source.repository
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .at(-1) ?? "skill";
    const candidates: Array<SkillSourcePreview["candidates"][number]> = [];
    for (const folder of folders) {
      const name = folder === "" ? repositoryName : path.basename(folder);
      if (!isSkillName(name)) continue;
      const description = yield* readDescription(path.join(checkout, folder));
      candidates.push({
        name: name as SkillName,
        ...(description ? { description } : {}),
        ...(folder ? { path: folder.split(path.sep).join("/") } : {}),
        exists: catalogNames.has(name),
      });
    }
    return { source, candidates } satisfies SkillSourcePreview;
  });

  const parseSource = (url: string) => {
    const source = parseSkillSourceUrl(url);
    return source
      ? Effect.succeed(source)
      : Effect.fail(fail("invalid-source", `'${url}' is not a git repository URL.`));
  };

  const previewSource = Effect.fn("SkillLibrary.previewSource")(function* (url: string) {
    const source = yield* parseSource(url);
    const snapshot = yield* scan();
    const catalogNames = new Set(
      snapshot.skills.filter((skill) => skill.catalogPath).map((skill) => skill.name),
    );
    return yield* Effect.scoped(
      cloneSource(source).pipe(
        Effect.flatMap((checkout) => previewIn(source, checkout, catalogNames)),
      ),
    );
  }, withPlatform);

  const findTarget = (snapshot: Scan, id: SkillTargetId) => {
    const target = snapshot.targets.find((candidate) => candidate.id === id);
    return target
      ? Effect.succeed(target)
      : Effect.fail(fail("unsupported-target", `'${id}' is not set up on this machine.`));
  };
  const findSkill = (snapshot: Scan, name: string) => {
    const skill = snapshot.skills.find((candidate) => candidate.name === name);
    return skill ? Effect.succeed(skill) : Effect.fail(notFound(name));
  };

  const copyIntoCatalog = (snapshot: Scan, from: string, name: string) =>
    fileSystem
      .makeDirectory(snapshot.catalogDirectory, { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.copy(from, path.join(snapshot.catalogDirectory, name))),
        Effect.mapError(filesystemError(`Could not copy '${name}' into the catalog`)),
      );

  const setTarget = Effect.fnUntraced(function* (
    snapshot: Scan,
    {
      name,
      target: targetId,
      enabled,
    }: { name: SkillName; target: SkillTargetId; enabled: boolean },
  ) {
    const target = yield* findTarget(snapshot, targetId);
    const skill = yield* findSkill(snapshot, name);
    const state = skill.targets[target.id] ?? "off";
    if (state === "external") {
      return yield* fail(
        "not-owned",
        `${target.displayName} has its own '${name}' at ${path.join(target.directory, name)}. T3 Code leaves it alone.`,
      );
    }
    if (enabled && state === "off") {
      if (!skill.catalogPath) return yield* notFound(name);
      yield* link(snapshot, name, target);
    }
    if (!enabled && state === "linked") yield* unlink(name, target);
    const active = snapshot.manifest.activeScenario;
    if (active !== null) {
      const scenarios = {
        ...snapshot.manifest.scenarios,
        [active]: withScenarioTarget(
          snapshot.manifest.scenarios[active] ?? {},
          name,
          target.id,
          enabled,
        ),
      };
      yield* saveManifest(snapshot.catalogDirectory, { ...snapshot.manifest, scenarios });
    }
  });

  const adopt = Effect.fnUntraced(function* (
    snapshot: Scan,
    { name, target: targetId }: { name: SkillName; target: SkillTargetId },
  ) {
    const target = yield* findTarget(snapshot, targetId);
    const skill = yield* findSkill(snapshot, name);
    if (skill.catalogPath)
      return yield* fail("already-exists", `The catalog already has '${name}'.`);
    if (skill.targets[target.id] !== "external") return yield* notFound(name);
    // Copy what a link points at, not the link, so the catalog owns real files.
    const from = yield* fileSystem
      .realPath(path.join(target.directory, name))
      .pipe(Effect.mapError(filesystemError(`Could not read ${target.displayName}'s '${name}'`)));
    yield* copyIntoCatalog(snapshot, from, name);
  });

  const deleteSkill = Effect.fnUntraced(function* (snapshot: Scan, name: SkillName) {
    const skill = yield* findSkill(snapshot, name);
    if (!skill.catalogPath) return yield* notFound(name);
    for (const target of snapshot.targets) {
      if (skill.targets[target.id] === "linked") yield* unlink(name, target);
    }
    yield* fileSystem
      .remove(skill.catalogPath, { recursive: true })
      .pipe(Effect.mapError(filesystemError(`Could not delete ${skill.catalogPath}`)));
    updateChecks.delete(name);
    const { [name]: _source, ...sources } = snapshot.manifest.sources;
    const scenarios = Object.fromEntries(
      Object.entries(snapshot.manifest.scenarios).map(([scenario, skills]) => {
        const { [name]: _removed, ...rest } = skills;
        return [scenario, rest];
      }),
    );
    if (snapshot.hasManifest) {
      yield* saveManifest(snapshot.catalogDirectory, { ...snapshot.manifest, sources, scenarios });
    }
  });

  const install = Effect.fnUntraced(function* (
    snapshot: Scan,
    { url, names }: { url: string; names: ReadonlyArray<SkillName> },
  ) {
    const source = yield* parseSource(url);
    const catalogNames = new Set(
      snapshot.skills.filter((skill) => skill.catalogPath).map((skill) => skill.name),
    );
    const sources = { ...snapshot.manifest.sources };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* cloneSource(source);
        const preview = yield* previewIn(source, checkout, catalogNames);
        for (const name of names) {
          const candidate = preview.candidates.find((entry) => entry.name === name);
          if (!candidate) return yield* fail("not-found", `${url} has no skill named '${name}'.`);
          if (candidate.exists) {
            return yield* fail("already-exists", `The catalog already has '${name}'.`);
          }
        }
        for (const name of names) {
          const candidate = preview.candidates.find((entry) => entry.name === name);
          yield* copyIntoCatalog(snapshot, path.join(checkout, candidate?.path ?? "."), name);
          sources[name] = {
            repository: source.repository,
            ...(source.ref ? { ref: source.ref } : {}),
            ...(candidate?.path ? { path: candidate.path } : {}),
          };
          updateChecks.set(name, { status: "current" });
        }
      }),
    );
    yield* saveManifest(snapshot.catalogDirectory, { ...snapshot.manifest, sources });
  });

  const update = Effect.fnUntraced(function* (snapshot: Scan, name: SkillName) {
    const skill = yield* findSkill(snapshot, name);
    if (!skill.catalogPath || !skill.source) {
      return yield* fail("invalid-source", `'${name}' has no source to update from.`);
    }
    const { catalogPath, source } = skill;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* cloneSource(source);
        const folder = yield* sourceFolder(checkout, source.path);
        if (!(yield* isSkillDirectory(folder))) {
          return yield* fail(
            "invalid-source",
            `${source.repository} no longer has a SKILL.md at '${source.path ?? "."}'.`,
          );
        }
        // Replace in place: links point at this path, so it must stay.
        yield* fileSystem
          .remove(catalogPath, { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.copy(folder, catalogPath)),
            Effect.mapError(filesystemError(`Could not update ${catalogPath}`)),
          );
      }),
    );
    updateChecks.set(name, { status: "current" });
  });

  const checkUpdates = Effect.fn("SkillLibrary.checkUpdates")(function* (snapshot: Scan) {
    const groups = new Map<string, { source: SkillSource; skills: SkillLibraryEntry[] }>();
    for (const skill of snapshot.skills) {
      if (!skill.source || !skill.catalogPath) continue;
      const key = sourceKey(skill.source);
      const group = groups.get(key) ?? { source: skill.source, skills: [] };
      group.skills.push(skill);
      groups.set(key, group);
    }
    yield* Effect.forEach(
      groups.values(),
      ({ source, skills }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const checkout = yield* cloneSource(source);
            for (const skill of skills) {
              const folder = yield* sourceFolder(checkout, skill.source?.path);
              const same = (yield* isSkillDirectory(folder))
                ? yield* sameSkillFiles(folder, skill.catalogPath ?? "").pipe(
                    Effect.orElseSucceed(() => false),
                  )
                : false;
              updateChecks.set(skill.name, { status: same ? "current" : "available" });
            }
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              for (const skill of skills) {
                updateChecks.set(skill.name, { status: "error", detail: error.detail });
              }
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
    updatesCheckedAt = yield* nowIso;
  });

  const requireRepository = (snapshot: Scan) =>
    snapshot.backup === null
      ? Effect.fail(fail("not-found", `${snapshot.catalogDirectory} is not a git repository.`))
      : Effect.void;

  const backUp = Effect.fn("SkillLibrary.backUp")(function* (snapshot: Scan) {
    yield* requireRepository(snapshot);
    yield* backUpCatalog(git, snapshot.catalogDirectory).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          backupStatus = { ...backupStatus, error: error.detail };
        }),
      ),
    );
    backupStatus = { lastBackupAt: yield* nowIso };
  });

  const activateScenario = Effect.fnUntraced(function* (snapshot: Scan, name: string) {
    const desired = snapshot.manifest.scenarios[name];
    if (desired === undefined) return yield* fail("not-found", `No scenario named '${name}'.`);
    for (const skill of snapshot.skills) {
      for (const target of snapshot.targets) {
        const want = desired[skill.name]?.includes(target.id) === true;
        const state = skill.targets[target.id];
        if (want && state === "off" && skill.catalogPath) yield* link(snapshot, skill.name, target);
        if (!want && state === "linked") yield* unlink(skill.name, target);
      }
    }
    yield* saveManifest(snapshot.catalogDirectory, { ...snapshot.manifest, activeScenario: name });
  });

  const importSkillsManager = Effect.fnUntraced(function* (snapshot: Scan) {
    if (snapshot.hasManifest) {
      return yield* fail("already-exists", "This catalog already has T3 Code's skill settings.");
    }
    const exported = yield* readSkillsManagerExport(snapshot.catalogDirectory, KNOWN_TARGET_IDS);
    if (Option.isNone(exported)) {
      return yield* fail("not-found", "No skills-manager.app data in the catalog.");
    }
    const { sources, scenarios } = exported.value;
    // skills-manager.app only gives the catalog a remote when its git backup is set up.
    const hasRemote =
      snapshot.backup !== null &&
      (yield* git
        .execute({
          operation: "SkillLibrary.importSkillsManager",
          cwd: snapshot.catalogDirectory,
          args: ["remote"],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) => result.stdout.trim() !== ""),
          Effect.orElseSucceed(() => false),
        ));
    const linked = linkedSkills(snapshot);
    // Every scenario keeps today's links for those tools, so switching leaves them alone.
    const withOutsideLinks = (skills: ScenarioSkills) =>
      Object.entries(linked).reduce(
        (merged, [name, targets]) =>
          targets
            .filter((target) => OUTSIDE_SKILLS_MANAGER.has(target))
            .reduce(
              (current, target) =>
                withScenarioTarget(current, name as SkillName, target as SkillTargetId, true),
              merged,
            ),
        skills,
      );
    yield* saveManifest(snapshot.catalogDirectory, {
      version: 1,
      sources,
      scenarios: Object.fromEntries(
        scenarios.map((scenario) => [scenario.name, withOutsideLinks(scenario.skills)]),
      ),
      activeScenario: closestScenario(
        scenarios,
        linked,
        new Set(
          snapshot.targets
            .map((target) => target.id)
            .filter((target) => !OUTSIDE_SKILLS_MANAGER.has(target)),
        ),
      ),
      ...(hasRemote ? { autoBackup: true } : {}),
    });
  });

  const run = (snapshot: Scan, mutation: SkillLibraryMutation) => {
    switch (mutation._tag) {
      case "setTarget":
        return setTarget(snapshot, mutation);
      case "adopt":
        return adopt(snapshot, mutation);
      case "delete":
        return deleteSkill(snapshot, mutation.name);
      case "install":
        return install(snapshot, mutation);
      case "checkUpdates":
        return checkUpdates(snapshot);
      case "update":
        return update(snapshot, mutation.name);
      case "activateScenario":
        return activateScenario(snapshot, mutation.name);
      case "saveScenario":
        return saveManifest(snapshot.catalogDirectory, {
          ...snapshot.manifest,
          scenarios: { ...snapshot.manifest.scenarios, [mutation.name]: linkedSkills(snapshot) },
          activeScenario: mutation.name,
        });
      case "deleteScenario": {
        const { [mutation.name]: _removed, ...scenarios } = snapshot.manifest.scenarios;
        return saveManifest(snapshot.catalogDirectory, {
          ...snapshot.manifest,
          scenarios,
          activeScenario:
            snapshot.manifest.activeScenario === mutation.name
              ? null
              : snapshot.manifest.activeScenario,
        });
      }
      case "importSkillsManager":
        return importSkillsManager(snapshot);
      case "setBackup":
        return requireRepository(snapshot).pipe(
          Effect.andThen(
            saveManifest(snapshot.catalogDirectory, {
              ...snapshot.manifest,
              autoBackup: mutation.enabled,
            }),
          ),
        );
      case "backUp":
        return backUp(snapshot);
    }
  };

  const autoBackUp = Effect.gen(function* () {
    const snapshot = yield* scan();
    if (snapshot.backup?.enabled) yield* backUp(snapshot);
  }).pipe(
    mutations.withPermits(1),
    withPlatform,
    Effect.catch((error) => Effect.logWarning("Skill catalog backup failed", error)),
  );

  // A newer change restarts the wait instead of interrupting a backup that is already running.
  const scheduleBackUp = Effect.suspend(() => {
    const generation = ++backupGeneration;
    return Effect.sleep(BACKUP_DELAY).pipe(
      Effect.andThen(
        Effect.suspend(() => (generation === backupGeneration ? autoBackUp : Effect.void)),
      ),
      Effect.forkIn(layerScope),
      Effect.asVoid,
    );
  });

  const changesCatalog = (mutation: SkillLibraryMutation) =>
    mutation._tag === "setBackup"
      ? mutation.enabled
      : mutation._tag !== "checkUpdates" && mutation._tag !== "backUp";

  const mutate = Effect.fn("SkillLibrary.mutate")(
    function* (mutation: SkillLibraryMutation) {
      yield* Effect.annotateCurrentSpan("skills.mutation", mutation._tag);
      const before = yield* scan();
      yield* run(before, mutation);
      const after = yield* scan();
      yield* refreshChangedProviders(before, after);
      if (after.backup?.enabled && changesCatalog(mutation)) yield* scheduleBackUp;
      return toSnapshot(after);
    },
    mutations.withPermits(1),
    withPlatform,
  );

  // Like skills-manager.app, check sources and back up edits made outside T3 in the background.
  yield* Effect.gen(function* () {
    const snapshot = yield* scan();
    if (snapshot.skills.some((skill) => skill.source)) yield* checkUpdates(snapshot);
  }).pipe(
    withPlatform,
    Effect.andThen(autoBackUp),
    Effect.repeat(Schedule.spaced(MAINTENANCE_INTERVAL)),
    Effect.delay(MAINTENANCE_START_DELAY),
    Effect.forkIn(layerScope),
  );

  return SkillLibrary.of({
    list: withPlatform(scan().pipe(Effect.map(toSnapshot))),
    previewSource,
    mutate,
  });
});

export const layer = Layer.effect(SkillLibrary, make);
