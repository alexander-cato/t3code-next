import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/** One path segment, so a name can never leave the directory it is joined to. */
export const SkillName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export type SkillName = typeof SkillName.Type;

export const SkillScenarioName = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type SkillScenarioName = typeof SkillScenarioName.Type;

/** A coding tool that reads skills from its own folder, such as `claude_code` or `windsurf`. */
export const SkillTargetId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9_]*$/),
);
export type SkillTargetId = typeof SkillTargetId.Type;

export const SkillTarget = Schema.Struct({
  id: SkillTargetId,
  displayName: TrimmedNonEmptyString,
  directory: TrimmedNonEmptyString,
  /** Set when the tool is also a T3 Code provider. */
  driver: Schema.optionalKey(ProviderDriverKind),
});
export type SkillTarget = typeof SkillTarget.Type;

/**
 * `linked`: a link to the catalog copy, which T3 manages. `external`: the tool's own folder or a
 * link elsewhere, which T3 never changes. `off`: the tool does not see the skill.
 */
export const SkillTargetState = Schema.Literals(["linked", "external", "off"]);
export type SkillTargetState = typeof SkillTargetState.Type;

/** Where a catalog skill came from, so it can be updated. */
export const SkillSource = Schema.Struct({
  repository: TrimmedNonEmptyString,
  ref: Schema.optionalKey(TrimmedNonEmptyString),
  /** The skill folder inside the repository; absent for the repository root. */
  path: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SkillSource = typeof SkillSource.Type;

export const SkillUpdateCheck = Schema.Struct({
  status: Schema.Literals(["current", "available", "error"]),
  detail: Schema.optionalKey(Schema.String),
});
export type SkillUpdateCheck = typeof SkillUpdateCheck.Type;

export const SkillLibraryEntry = Schema.Struct({
  name: SkillName,
  description: Schema.optionalKey(TrimmedNonEmptyString),
  /** Absent when only a tool's own folder has this skill. */
  catalogPath: Schema.optionalKey(TrimmedNonEmptyString),
  source: Schema.optionalKey(SkillSource),
  /** The last update check, for skills with a source. */
  update: Schema.optionalKey(SkillUpdateCheck),
  targets: Schema.Record(SkillTargetId, SkillTargetState),
});
export type SkillLibraryEntry = typeof SkillLibraryEntry.Type;

export const SkillScenarioSummary = Schema.Struct({
  name: SkillScenarioName,
  skillCount: Schema.Number,
});
export type SkillScenarioSummary = typeof SkillScenarioSummary.Type;

/** Committing and pushing the catalog after changes, offered when it is a git repository. */
export const SkillCatalogBackup = Schema.Struct({
  enabled: Schema.Boolean,
  /** When this server last backed up, as an ISO time. */
  lastBackupAt: Schema.optionalKey(Schema.String),
  /** Why the last backup failed. */
  error: Schema.optionalKey(Schema.String),
});
export type SkillCatalogBackup = typeof SkillCatalogBackup.Type;

export const SkillLibrarySnapshot = Schema.Struct({
  catalogDirectory: TrimmedNonEmptyString,
  targets: Schema.Array(SkillTarget),
  skills: Schema.Array(SkillLibraryEntry),
  scenarios: Schema.Array(SkillScenarioSummary),
  /** Toggles also edit this scenario. */
  activeScenario: Schema.NullOr(SkillScenarioName),
  /** skills-manager.app data sits in the catalog and has not been imported yet. */
  canImportSkillsManager: Schema.Boolean,
  /** When this server last checked sources for updates, as an ISO time. */
  updatesCheckedAt: Schema.optionalKey(Schema.String),
  /** Null when the catalog is not a git repository. */
  backup: Schema.NullOr(SkillCatalogBackup),
});
export type SkillLibrarySnapshot = typeof SkillLibrarySnapshot.Type;

export const SkillLibraryListInput = Schema.Struct({});
export type SkillLibraryListInput = typeof SkillLibraryListInput.Type;

export const SkillSourceUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));

export const SkillLibraryPreviewSourceInput = Schema.Struct({ url: SkillSourceUrl });
export type SkillLibraryPreviewSourceInput = typeof SkillLibraryPreviewSourceInput.Type;

export const SkillSourcePreview = Schema.Struct({
  source: SkillSource,
  candidates: Schema.Array(
    Schema.Struct({
      name: SkillName,
      description: Schema.optionalKey(TrimmedNonEmptyString),
      path: Schema.optionalKey(TrimmedNonEmptyString),
      /** The catalog already has a skill with this name. */
      exists: Schema.Boolean,
    }),
  ),
});
export type SkillSourcePreview = typeof SkillSourcePreview.Type;

export const SkillLibraryMutation = Schema.Union([
  Schema.TaggedStruct("setTarget", {
    name: SkillName,
    target: SkillTargetId,
    enabled: Schema.Boolean,
  }),
  /** Copies a tool's own skill into the catalog. */
  Schema.TaggedStruct("adopt", { name: SkillName, target: SkillTargetId }),
  /** Removes the catalog copy, its links, its source, and its scenario entries. */
  Schema.TaggedStruct("delete", { name: SkillName }),
  Schema.TaggedStruct("install", {
    url: SkillSourceUrl,
    names: Schema.Array(SkillName).check(Schema.isMinLength(1)),
  }),
  /** Fetches every source and compares it with the catalog copy. */
  Schema.TaggedStruct("checkUpdates", {}),
  /** Replaces the catalog copy with its source's current files. */
  Schema.TaggedStruct("update", { name: SkillName }),
  /** Links exactly the scenario's skills, then makes it the one toggles edit. */
  Schema.TaggedStruct("activateScenario", { name: SkillScenarioName }),
  /** Saves the current links as a scenario, replacing one with that name, and activates it. */
  Schema.TaggedStruct("saveScenario", { name: SkillScenarioName }),
  Schema.TaggedStruct("deleteScenario", { name: SkillScenarioName }),
  /** Reads skills-manager.app's sources and scenarios from the catalog once. */
  Schema.TaggedStruct("importSkillsManager", {}),
  /** Turns committing and pushing the catalog after each change on or off. */
  Schema.TaggedStruct("setBackup", { enabled: Schema.Boolean }),
  /** Commits and pushes the catalog now. */
  Schema.TaggedStruct("backUp", {}),
]);
export type SkillLibraryMutation = typeof SkillLibraryMutation.Type;

export class SkillLibraryError extends Schema.TaggedError<SkillLibraryError>()(
  "SkillLibraryError",
  {
    reason: Schema.Literals([
      "not-found",
      "unsupported-target",
      "not-owned",
      "already-exists",
      "invalid-source",
      "git-error",
      "filesystem-error",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
