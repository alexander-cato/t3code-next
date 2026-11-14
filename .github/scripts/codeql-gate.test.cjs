const assert = require("node:assert/strict");
const test = require("node:test");
const { addedLines, introducedFindings } = require("./codeql-gate.cjs");

const DIFF = [
  "diff --git a/src/new.ts b/src/new.ts",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,3 @@",
  "+a",
  "+b",
  "+c",
  "diff --git a/src/old.ts b/src/old.ts",
  "--- a/src/old.ts",
  "+++ b/src/old.ts",
  "@@ -10 +10 @@",
  "-x",
  "+y",
  "@@ -20,2 +19,0 @@",
  "-gone",
  "-gone",
  "diff --git a/src/removed.ts b/src/removed.ts",
  "--- a/src/removed.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-a",
  "-b",
  "",
].join("\n");

function location(uri, startLine) {
  return { physicalLocation: { artifactLocation: { uri }, region: { startLine } } };
}

function sarif(results, severity = "8.8") {
  return {
    runs: [
      {
        tool: {
          driver: { rules: [] },
          extensions: [
            {
              rules: [
                { id: "js/sql-injection", properties: { "security-severity": severity } },
                { id: "js/unused-local-variable", properties: {} },
              ],
            },
          ],
        },
        results,
      },
    ],
  };
}

test("records only the lines a diff adds", () => {
  const added = addedLines(DIFF);
  assert.deepEqual([...added.keys()], ["src/new.ts", "src/old.ts"]);
  assert.deepEqual([...added.get("src/new.ts")], [1, 2, 3]);
  assert.deepEqual([...added.get("src/old.ts")], [10]);
});

test("blocks introduced high-severity results and ignores pre-existing ones", () => {
  const result = (extra) => ({ ruleId: "js/sql-injection", message: { text: "query" }, ...extra });
  const cases = [
    [{ locations: [location("src/new.ts", 2)] }, true],
    [{ locations: [location("src/old.ts", 10)] }, true],
    [{ locations: [location("src/old.ts", 11)] }, false],
    [{ locations: [location("src/untouched.ts", 1)] }, false],
    // A pre-existing sink counts when the change adds a step of the flow that reaches it.
    [
      {
        locations: [location("src/untouched.ts", 5)],
        codeFlows: [{ threadFlows: [{ locations: [{ location: location("src/new.ts", 1) }] }] }],
      },
      true,
    ],
    [{ locations: [location("src/new.ts", 1)], suppressions: [{ kind: "inSource" }] }, false],
  ];
  for (const [extra, blocked] of cases) {
    const findings = introducedFindings([sarif([result(extra)])], DIFF, 7);
    assert.equal(findings.length, blocked ? 1 : 0, JSON.stringify(extra));
    if (blocked) assert.equal(findings[0].blocking, true);
  }
});

test("reports introduced results below the threshold without blocking, and skips quality rules", () => {
  const findings = introducedFindings(
    [
      sarif(
        [
          { ruleId: "js/sql-injection", locations: [location("src/new.ts", 1)] },
          { ruleId: "js/unused-local-variable", locations: [location("src/new.ts", 1)] },
        ],
        "5.0",
      ),
    ],
    DIFF,
    7,
  );
  assert.deepEqual(
    findings.map(({ ruleId, blocking }) => ({ ruleId, blocking })),
    [{ ruleId: "js/sql-injection", blocking: false }],
  );
});
