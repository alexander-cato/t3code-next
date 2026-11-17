const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

test("the server shard command uses options accepted by the current cached-test runner", () => {
  const workflow = readFileSync(join(__dirname, "../workflows/ci.yml"), "utf8");
  const job = workflow.split("\n  test_server:\n")[1];
  const command = job.match(/        run: >-\n((?:          .+\n)+)/)[1];
  const args = command
    .replace(/\$\{\{ matrix.shard \}\}/g, "1")
    .replace(/\$\{\{ strategy.job-total \}\}/g, "8")
    .replace(/\$\{\{ runner.temp \}\}/g, tmpdir())
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/^"(.*)"$/, "$1"));
  assert.deepEqual(args.slice(0, 3), ["vp", "run", "test:cached"]);
  const result = spawnSync(
    process.execPath,
    [join(__dirname, "../../scripts/test-cached.ts"), ...args.slice(3), "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("compares context growth against the PR base instead of the older default branch", () => {
  const directory = mkdtempSync(join(tmpdir(), "t3-pr-budget-"));
  try {
    const git = (...args) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    const budget = join(directory, "budget.json");
    writeFileSync(budget, JSON.stringify({ context: 10 }));
    git("add", "budget.json");
    git("commit", "-m", "older default branch");
    const upstreamBase = git("rev-parse", "HEAD");
    git("switch", "-c", "fork/nightly");
    writeFileSync(budget, JSON.stringify({ context: 20 }));
    git("commit", "-am", "included upstream nightly");
    const base = git("rev-parse", "HEAD");
    git("switch", "-c", "upstream", upstreamBase);
    writeFileSync(budget, JSON.stringify({ context: 15 }));
    git("commit", "-am", "newer upstream nightly");
    const nightly = git("rev-parse", "HEAD");
    git("switch", "-c", "fork-work/test", base);
    git("remote", "add", "origin", directory);

    const workflow = readFileSync(join(__dirname, "../workflows/agent-context-budget.yml"), "utf8");
    const script = workflow
      .split("      - name: Compare with PR base\n")[1]
      .split("        run: |\n")[1]
      .replace(/^          /gm, "");
    const run = (allow = "false", upstream = {}) =>
      spawnSync("bash", ["-e", "-c", script], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          BUDGET: "budget.json",
          BASE_SHA: base,
          RUNNER_TEMP: directory,
          ALLOW_INCREASE: allow,
          ...upstream,
        },
      });
    const unchanged = run();
    assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
    writeFileSync(budget, JSON.stringify({ context: 21 }));
    const grown = run();
    assert.equal(grown.status, 1, grown.stdout + grown.stderr);
    assert.match(grown.stdout, /context: 20 -> 21/);
    assert.equal(run("true").status, 0);
    // A nightly candidate may also carry the +5 its upstream nightly added, but no fork growth.
    const candidate = { NIGHTLY: nightly, NIGHTLY_BASE: upstreamBase };
    writeFileSync(budget, JSON.stringify({ context: 25 }));
    const merged = run("false", candidate);
    assert.equal(merged.status, 0, merged.stdout + merged.stderr);
    writeFileSync(budget, JSON.stringify({ context: 26 }));
    const forkGrown = run("false", candidate);
    assert.equal(forkGrown.status, 1, forkGrown.stdout + forkGrown.stderr);
    assert.match(forkGrown.stdout, /context: 20 -> 26 \(\+6, upstream nightly \+5\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
