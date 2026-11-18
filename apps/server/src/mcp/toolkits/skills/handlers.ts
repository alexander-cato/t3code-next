import { OrchestratorMcpFailure, type SkillLibraryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SkillLibrary from "../../../provider/SkillLibrary.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SkillsToolkit } from "./tools.ts";

const toFailure = (error: SkillLibraryError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "filesystem-error" || error.reason === "git-error"
        ? "orchestration_error"
        : "invalid_request",
    message: error.detail,
  });

export const layer = McpToolAccess.toLayer(SkillsToolkit, {
  t3_skills_read: McpToolAccess.reads(({ name, previewUrl }) =>
    Effect.gen(function* () {
      const library = yield* SkillLibrary.SkillLibrary;
      const snapshot = yield* library.list.pipe(Effect.mapError(toFailure));
      const preview =
        previewUrl === undefined
          ? undefined
          : yield* library.previewSource(previewUrl).pipe(Effect.mapError(toFailure));
      return {
        ...snapshot,
        skills:
          name === undefined
            ? snapshot.skills
            : snapshot.skills.filter((skill) => skill.name === name),
        ...(preview ? { preview } : {}),
      };
    }),
  ),
  t3_skills_update: McpToolAccess.writesEnvironment((mutation, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const library = yield* SkillLibrary.SkillLibrary;
      // The turn may have ended, or the thread's modes changed, while this waited for the lock.
      const update = check.pipe(
        Effect.andThen(library.mutate(mutation).pipe(Effect.mapError(toFailure))),
      );
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
