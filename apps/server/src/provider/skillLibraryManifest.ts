import { SkillSource, type SkillName, type SkillTargetId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parseSkillSourceUrl } from "./skillLibrarySources.ts";

/** Skill name to the targets that link it. */
export type ScenarioSkills = Readonly<Record<string, ReadonlyArray<string>>>;

const SkillManifest = Schema.Struct({
  version: Schema.Literal(1),
  sources: Schema.Record(Schema.String, SkillSource),
  scenarios: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Array(Schema.String)),
  ),
  activeScenario: Schema.NullOr(Schema.String),
  /** Commit and push the catalog after changes. */
  autoBackup: Schema.optionalKey(Schema.Boolean),
});
export type SkillManifest = typeof SkillManifest.Type;

// Indented, because the catalog is often a git repository.
const SkillManifestJson = Schema.fromJsonString(SkillManifest, { space: 2 });
const decodeManifest = Schema.decodeUnknownOption(SkillManifestJson);
const encodeManifest = Schema.encodeEffect(SkillManifestJson);

export const EMPTY_MANIFEST: SkillManifest = {
  version: 1,
  sources: {},
  scenarios: {},
  activeScenario: null,
};

/** Lives in the catalog so a catalog kept in git carries its sources and scenarios with it. */
export const MANIFEST_FILE = ".t3-skills.json";

export const readManifest = Effect.fn("skillLibraryManifest.read")(function* (catalog: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fileSystem
    .readFileString(path.join(catalog, MANIFEST_FILE))
    .pipe(Effect.option);
  return Option.flatMap(contents, decodeManifest);
});

export const writeManifest = Effect.fn("skillLibraryManifest.write")(function* (
  catalog: string,
  manifest: SkillManifest,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(catalog, MANIFEST_FILE);
  const staged = `${file}.tmp`;
  yield* fileSystem.makeDirectory(catalog, { recursive: true });
  yield* fileSystem.writeFileString(staged, `${yield* encodeManifest(manifest)}\n`);
  yield* fileSystem.rename(staged, file);
});

const SkillsManagerSkill = Schema.Struct({
  skill_id: Schema.String,
  path: Schema.String,
  source: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        type: Schema.String,
        ref: Schema.optional(Schema.NullOr(Schema.String)),
        subpath: Schema.optional(Schema.NullOr(Schema.String)),
        branch: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const SkillsManagerScenario = Schema.Struct({
  scenario_id: Schema.String,
  name: Schema.String,
  sort_order: Schema.optional(Schema.NullOr(Schema.Number)),
});
const SkillsManagerScenarioSkill = Schema.Struct({
  skill_id: Schema.String,
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
const decodeSkill = Schema.decodeUnknownOption(Schema.fromJsonString(SkillsManagerSkill));
const decodeScenario = Schema.decodeUnknownOption(Schema.fromJsonString(SkillsManagerScenario));
const decodeScenarioSkill = Schema.decodeUnknownOption(
  Schema.fromJsonString(SkillsManagerScenarioSkill),
);

/** The folder skills-manager.app mirrors its database into, inside the catalog. */
const SKILLS_MANAGER_DIRECTORY = ".skills-manager";

/** skills-manager.app keeps a GitHub tree URL or `owner/repo/skill` beside the folder path. */
function skillsManagerSource(source: {
  readonly type: string;
  readonly ref?: string | null | undefined;
  readonly subpath?: string | null | undefined;
  readonly branch?: string | null | undefined;
}): SkillSource | undefined {
  if (!source.ref) return undefined;
  const parsed =
    source.type === "git"
      ? parseSkillSourceUrl(source.ref)
      : source.type === "skillssh"
        ? parseSkillSourceUrl(source.ref.split("/").slice(0, 2).join("/"))
        : undefined;
  if (!parsed) return undefined;
  const ref = source.branch ?? parsed.ref;
  const subpath = source.subpath ?? parsed.path;
  return {
    repository: parsed.repository,
    ...(ref ? { ref } : {}),
    ...(subpath ? { path: subpath } : {}),
  };
}

const readJsonFiles = Effect.fnUntraced(function* <A>(
  directory: string,
  decode: (contents: string) => Option.Option<A>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  const results: A[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).toSorted()) {
    const contents = yield* fileSystem
      .readFileString(path.join(directory, name))
      .pipe(Effect.option);
    const decoded = Option.flatMap(contents, decode);
    if (Option.isSome(decoded)) results.push(decoded.value);
  }
  return results;
});

export interface SkillsManagerExport {
  readonly sources: Record<string, SkillSource>;
  /** In the app's order. */
  readonly scenarios: ReadonlyArray<{ readonly name: string; readonly skills: ScenarioSkills }>;
}

/** None when the catalog holds no skills-manager.app data. */
export const readSkillsManagerExport = Effect.fn("skillLibraryManifest.readSkillsManagerExport")(
  function* (catalog: string, knownTargets: ReadonlySet<string>) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(catalog, SKILLS_MANAGER_DIRECTORY);
    if (
      !(yield* fileSystem.exists(path.join(root, "skills")).pipe(Effect.orElseSucceed(() => false)))
    )
      return Option.none<SkillsManagerExport>();

    const skills = yield* readJsonFiles(path.join(root, "skills"), decodeSkill);
    const nameById = new Map(skills.map((skill) => [skill.skill_id, skill.path]));
    const sources: Record<string, SkillSource> = {};
    for (const skill of skills) {
      const source = skill.source ? skillsManagerSource(skill.source) : undefined;
      if (source) sources[skill.path] = source;
    }

    const scenarios = (yield* readJsonFiles(path.join(root, "scenarios"), decodeScenario)).toSorted(
      (left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0),
    );
    const result: Array<{ name: string; skills: ScenarioSkills }> = [];
    for (const scenario of scenarios) {
      const members = yield* readJsonFiles(
        path.join(root, "scenario-skills", scenario.scenario_id),
        decodeScenarioSkill,
      );
      const scenarioSkills: Record<string, string[]> = {};
      for (const member of members) {
        const name = nameById.get(member.skill_id);
        if (name === undefined) continue;
        scenarioSkills[name] = Object.entries(member.tools ?? {})
          .filter(([tool, enabled]) => enabled && knownTargets.has(tool))
          .map(([tool]) => tool)
          .toSorted();
      }
      result.push({ name: scenario.name, skills: scenarioSkills });
    }
    return Option.some<SkillsManagerExport>({ sources, scenarios: result });
  },
);

/**
 * The scenario whose links overlap most with what is on disk, since the app's active choice is not
 * exported. Only `visibleTargets` count: a tool that is not installed has no links to compare.
 */
export function closestScenario(
  scenarios: ReadonlyArray<{ readonly name: string; readonly skills: ScenarioSkills }>,
  linked: ScenarioSkills,
  visibleTargets: ReadonlySet<string>,
): string | null {
  const pairs = (skills: ScenarioSkills) =>
    new Set(
      Object.entries(skills).flatMap(([skill, targets]) =>
        targets
          .filter((target) => visibleTargets.has(target))
          .map((target) => `${skill}\0${target}`),
      ),
    );
  const linkedPairs = pairs(linked);
  let best: { name: string; score: number } | null = null;
  for (const scenario of scenarios) {
    const scenarioPairs = pairs(scenario.skills);
    const shared = [...scenarioPairs].filter((pair) => linkedPairs.has(pair)).length;
    const union = scenarioPairs.size + linkedPairs.size - shared;
    const score = union === 0 ? 0 : shared / union;
    if (best === null || score > best.score) best = { name: scenario.name, score };
  }
  return best?.name ?? null;
}

export function withScenarioTarget(
  skills: ScenarioSkills,
  name: SkillName,
  target: SkillTargetId,
  enabled: boolean,
): ScenarioSkills {
  const current = skills[name] ?? [];
  const next = enabled
    ? [...new Set([...current, target])].toSorted()
    : current.filter((entry) => entry !== target);
  const { [name]: _removed, ...rest } = skills;
  return next.length === 0 ? rest : { ...rest, [name]: next };
}
