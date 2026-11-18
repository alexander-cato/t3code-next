import { SkillLibraryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const NETWORK_TIMEOUT_MS = 120_000;
const COMMIT_MESSAGE = "Back up skills";

const gitError = (detail: string) =>
  new SkillLibraryError({ reason: "git-error", detail: `Backup failed: ${detail}` });
/** Git's `fatal:` or `error:` line says what went wrong; hints follow it. */
const gitReason = (output: string) => {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = lines.find((line) => /^(fatal|error): /.test(line)) ?? lines.at(-1);
  return reason?.replace(/^(fatal|error): /, "") ?? "unknown error";
};

/**
 * Commits everything in the catalog and pushes the current branch to `origin`, or the only remote.
 * When another machine pushed first, rebases onto it once and pushes again.
 */
export const backUpCatalog = Effect.fn("skillLibraryBackup.backUpCatalog")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  catalog: string,
) {
  const run = (args: ReadonlyArray<string>, timeoutMs?: number) =>
    git
      .execute({
        operation: "SkillLibrary.backUp",
        cwd: catalog,
        args,
        allowNonZeroExit: true,
        env: { GIT_TERMINAL_PROMPT: "0", LANGUAGE: "C" },
        ...(timeoutMs ? { timeoutMs } : {}),
      })
      .pipe(Effect.mapError((error) => gitError(error.message)));
  const succeed = Effect.fnUntraced(function* (args: ReadonlyArray<string>, timeoutMs?: number) {
    const result = yield* run(args, timeoutMs);
    if (result.exitCode !== 0) return yield* gitError(gitReason(result.stderr || result.stdout));
    return result.stdout.trim();
  });

  const remotes = (yield* succeed(["remote"])).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  if (!remote) return yield* gitError("the catalog repository has no remote named origin.");
  const branch = (yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!branch) return yield* gitError("the catalog repository is not on a branch.");

  const identity =
    (yield* run(["config", "user.email"])).stdout.trim() === ""
      ? ["-c", "user.name=T3 Code", "-c", "user.email=t3code@localhost"]
      : [];
  yield* succeed(["add", "--all"]);
  if ((yield* run(["diff", "--cached", "--quiet"])).exitCode !== 0) {
    yield* succeed([...identity, "commit", "--quiet", "--message", COMMIT_MESSAGE]);
  }

  const push = ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`];
  if ((yield* run(push, NETWORK_TIMEOUT_MS)).exitCode === 0) return;
  const pulled = yield* run(
    [...identity, "pull", "--rebase", "--quiet", remote, branch],
    NETWORK_TIMEOUT_MS,
  );
  if (pulled.exitCode !== 0) {
    yield* run(["rebase", "--abort"]);
    return yield* gitError(gitReason(pulled.stderr || pulled.stdout));
  }
  yield* succeed(push, NETWORK_TIMEOUT_MS);
});
