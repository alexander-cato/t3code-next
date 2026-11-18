import type { SkillSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const GITHUB_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)((?:\/[^/]+)*))?\/?$/;
const SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[A-Za-z0-9_.-]+)*)\/?$/;

/**
 * GitHub repository, tree, and blob URLs, `owner/repo[/path]` shorthand, and any other git URL as a
 * whole repository. Branch names with slashes are read up to the first slash.
 */
export function parseSkillSourceUrl(input: string): SkillSource | undefined {
  const value = input.trim();
  const shorthand = SHORTHAND.exec(value);
  if (shorthand && !value.includes(":")) {
    const [, owner, repo, rest] = shorthand;
    const path = rest?.replace(/^\//, "");
    return {
      repository: `https://github.com/${owner}/${repo}`,
      ...(path ? { path } : {}),
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // scp-style `git@host:owner/repo.git`
    return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(value) ? { repository: value } : undefined;
  }
  if (!["https:", "http:", "ssh:", "file:"].includes(url.protocol)) return undefined;
  if (url.hostname !== "github.com") return { repository: value };
  const match = GITHUB_PATH.exec(url.pathname);
  if (!match) return undefined;
  const [, owner, repo, , ref, rest] = match;
  const path = rest?.replace(/^\//, "").replace(/\/?SKILL\.md$/, "");
  return {
    repository: `https://github.com/${owner}/${repo}`,
    ...(ref ? { ref } : {}),
    ...(path ? { path } : {}),
  };
}

export const sourceKey = (source: SkillSource) => `${source.repository}#${source.ref ?? ""}`;

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);
const MAX_DEPTH = 4;

/** Skill folders at or under `base`, relative to `root`; a folder holding SKILL.md is not searched further. */
export const findSkillFolders = Effect.fn("skillLibrarySources.findSkillFolders")(function* (
  root: string,
  base: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: string[] = [];
  const hasSkillFile = (directory: string) =>
    fileSystem.stat(path.join(directory, "SKILL.md")).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
  // Untraced: one call per folder, inside findSkillFolders' span.
  const walk: (directory: string, depth: number) => Effect.Effect<void> = Effect.fnUntraced(
    function* (directory, depth) {
      if (yield* hasSkillFile(directory)) {
        found.push(path.relative(root, directory));
        return;
      }
      if (depth >= MAX_DEPTH) return;
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed(() => []));
      for (const entry of entries.toSorted()) {
        if (entry.startsWith(".") || SKIPPED_DIRECTORIES.has(entry)) continue;
        const child = path.join(directory, entry);
        const info = yield* fileSystem.stat(child).pipe(Effect.option);
        if (info._tag === "Some" && info.value.type === "Directory") yield* walk(child, depth + 1);
      }
    },
  );
  yield* walk(base, 0);
  return found;
});

/** Same files with the same bytes, ignoring `.git`. */
export const sameSkillFiles = Effect.fn("skillLibrarySources.sameSkillFiles")(function* (
  left: string,
  right: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = (directory: string) =>
    fileSystem.readDirectory(directory, { recursive: true }).pipe(
      Effect.flatMap((entries) =>
        Effect.filter(
          entries.filter((entry) => !entry.split(path.sep).includes(".git")).toSorted(),
          (entry) =>
            fileSystem.stat(path.join(directory, entry)).pipe(
              Effect.map((info) => info.type === "File"),
              Effect.orElseSucceed(() => false),
            ),
        ),
      ),
    );
  const leftFiles = yield* files(left);
  const rightFiles = yield* files(right);
  if (leftFiles.join("\n") !== rightFiles.join("\n")) return false;
  for (const file of leftFiles) {
    const a = yield* fileSystem.readFile(path.join(left, file));
    const b = yield* fileSystem.readFile(path.join(right, file));
    if (a.length !== b.length || a.some((byte, index) => byte !== b[index])) return false;
  }
  return true;
});
