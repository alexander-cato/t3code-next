import { assert, describe, it } from "@effect/vitest";

import { devinSkillCommandText } from "./adapter.ts";

describe("devinSkillCommandText", () => {
  const skills = new Set(["file-pr"]);
  it.each([
    ["$file-pr fix the title", "/file-pr fix the title"],
    ["  $file-pr", "/file-pr"],
    // Only skills Devin listed become commands, so other `$` text reaches Devin as typed.
    ["$HOME is unset", "$HOME is unset"],
    ["$25 budget", "$25 budget"],
    ["please $file-pr", "please $file-pr"],
  ])("sends %j as %j", (text, expected) => {
    assert.equal(devinSkillCommandText(text, skills), expected);
  });
});
