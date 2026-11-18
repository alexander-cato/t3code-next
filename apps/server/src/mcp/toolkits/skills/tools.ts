import {
  OrchestratorMcpFailure,
  SkillLibraryMutation,
  SkillLibrarySnapshot,
  SkillName,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SkillLibrary from "../../../provider/SkillLibrary.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    SkillLibrary.SkillLibrary,
  ],
};

const SkillsReadTool = Tool.make("t3_skills_read", {
  ...shared,
  description:
    "List this machine's skill catalog: each skill's source, update status, and which coding tools link it, plus scenarios.",
  parameters: Schema.Struct({
    name: Schema.optionalKey(SkillName.annotate({ description: "Only this skill." })),
  }),
  success: SkillLibrarySnapshot,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SkillsUpdateTool = Tool.make("t3_skills_update", {
  ...shared,
  description:
    "Change the skill catalog, only when the user asks. Link or unlink a skill for a tool, install from a git URL (an unknown name returns the skills it offers), check for or apply updates, copy a tool's own skill into the catalog, delete, save/activate/delete scenarios, or turn on or run the catalog's git backup. Live full-access or default caller thread only.",
  parameters: SkillLibraryMutation,
  success: SkillLibrarySnapshot,
}).annotate(Tool.Destructive, true);

export const SkillsToolkit = Toolkit.make(SkillsReadTool, SkillsUpdateTool);
