// Fails only on CodeQL results that touch lines the change adds, so the alerts already in
// upstream's code do not block every nightly sync. With several diffs, a line counts as added
// only when every diff adds it: a nightly candidate diffed against main and against the upstream
// nightly it merges adds only the fork's own lines.

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function addedLines(diff) {
  const files = new Map();
  let lines;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      lines = path === "/dev/null" ? undefined : new Set();
      if (lines) files.set(path.replace(/^b\//, ""), lines);
      continue;
    }
    const hunk = lines && HUNK.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let offset = 0; offset < count; offset++) lines.add(start + offset);
  }
  return files;
}

function addedInEvery(diffs) {
  const [first, ...rest] = diffs.map(addedLines);
  for (const [path, lines] of first)
    for (const line of lines)
      if (!rest.every((added) => added.get(path)?.has(line))) lines.delete(line);
  return first;
}

function ruleIndex(run) {
  const rules = new Map();
  for (const component of [run.tool?.driver, ...(run.tool?.extensions ?? [])]) {
    for (const rule of component?.rules ?? []) if (rule?.id) rules.set(rule.id, rule);
  }
  return rules;
}

function* resultLocations(result) {
  yield* result.locations ?? [];
  yield* result.relatedLocations ?? [];
  for (const flow of result.codeFlows ?? [])
    for (const thread of flow.threadFlows ?? [])
      for (const step of thread.locations ?? []) if (step.location) yield step.location;
}

function touchesAddedLine(result, added) {
  for (const location of resultLocations(result)) {
    const physical = location.physicalLocation;
    const lines = added.get(physical?.artifactLocation?.uri);
    const start = physical?.region?.startLine;
    if (!lines || !Number.isInteger(start)) continue;
    const end = physical.region.endLine ?? start;
    for (let line = start; line <= end; line++) if (lines.has(line)) return true;
  }
  return false;
}

function introducedFindings(sarifs, diffs, threshold) {
  const added = addedInEvery(diffs);
  const findings = [];
  for (const sarif of sarifs) {
    for (const run of sarif.runs ?? []) {
      const rules = ruleIndex(run);
      for (const result of run.results ?? []) {
        if (result.suppressions?.length) continue;
        const rule = rules.get(result.ruleId ?? result.rule?.id);
        const severity = Number(rule?.properties?.["security-severity"]);
        if (!Number.isFinite(severity) || !touchesAddedLine(result, added)) continue;
        const physical = result.locations?.[0]?.physicalLocation;
        findings.push({
          ruleId: result.ruleId ?? rule.id,
          severity,
          blocking: severity >= threshold,
          file: physical?.artifactLocation?.uri,
          line: physical?.region?.startLine,
          message: result.message?.text ?? "",
        });
      }
    }
  }
  return findings;
}

module.exports = { addedLines, introducedFindings };

if (require.main === module) {
  const { readFileSync, readdirSync } = require("node:fs");
  const { join } = require("node:path");
  const [resultsDir, thresholdArg, ...diffFiles] = process.argv.slice(2);
  const threshold = Number(thresholdArg);
  if (!resultsDir || diffFiles.length === 0 || !Number.isFinite(threshold)) {
    console.error(
      "usage: codeql-gate.cjs <sarif-dir> <security-severity threshold> <diff-file>...",
    );
    process.exit(2);
  }
  const files = readdirSync(resultsDir).filter((name) => name.endsWith(".sarif"));
  if (files.length === 0) {
    console.error(`No SARIF files in ${resultsDir}.`);
    process.exit(2);
  }
  const sarifs = files.map((name) => JSON.parse(readFileSync(join(resultsDir, name), "utf8")));
  const diffs = diffFiles.map((file) => readFileSync(file, "utf8"));
  const findings = introducedFindings(sarifs, diffs, threshold);
  for (const finding of findings) {
    const level = finding.blocking ? "error" : "warning";
    const where = finding.file ? ` file=${finding.file},line=${finding.line ?? 1}` : "";
    console.log(
      `::${level}${where}::${finding.ruleId} (security-severity ${finding.severity}): ${finding.message.replace(/\s+/g, " ")}`,
    );
  }
  const blocking = findings.filter((finding) => finding.blocking).length;
  console.log(
    `${findings.length} CodeQL security result(s) touch added lines; ${blocking} at or above ${threshold}.`,
  );
  process.exit(blocking ? 1 : 0);
}
