const assert = require("node:assert/strict");
const test = require("node:test");
const childProcess = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { selectNightly, syncUpstreamNightly } = require("./sync-upstream-nightly.cjs");
const MAIN = "a".repeat(40),
  UPSTREAM = "b".repeat(40),
  CANDIDATE = "c".repeat(40),
  OLD = "d".repeat(40);
const repository = "alexander-cato/t3code-next";
function fixture() {
  const state = {
    branches: { main: MAIN, "upstream/nightly": OLD },
    verified: true,
    contained: false,
    conflict: false,
    stale: false,
    existingRuns: false,
    calls: [],
    pull: undefined,
    issues: [],
  };
  const listForRepo = async () => {};
  const github = {
    paginate: async (method) =>
      method === listForRepo
        ? state.issues.filter((issue) => issue.state === "open")
        : [
            {
              tag_name: "v0.1.10-nightly.20261114.4669",
              draft: false,
              published_at: "2026-11-14T03:00:00Z",
            },
          ],
    rest: {
      issues: {
        listForRepo,
        create: async ({ title, body, assignees }) => {
          state.calls.push(["issue", assignees]);
          const number = 100 + state.issues.length;
          state.issues.push({
            number,
            title,
            body,
            state: "open",
            html_url: `#${number}`,
            user: { login: "github-actions[bot]" },
          });
          return { data: state.issues.at(-1) };
        },
        update: async ({ issue_number, title, body, state: issueState }) => {
          state.calls.push(["issue-update"]);
          const issue = state.issues.find((item) => item.number === issue_number);
          if (title) Object.assign(issue, { title, body });
          if (issueState) issue.state = issueState;
        },
        createComment: async () => {},
      },
      repos: {
        listReleases: () => {},
        getBranch: async ({ branch }) => {
          if (!state.branches[branch]) throw Object.assign(new Error("missing"), { status: 404 });
          return { data: { commit: { sha: state.branches[branch] } } };
        },
        getCommit: async ({ ref }) => ({
          data: {
            sha: ref.startsWith("v") ? UPSTREAM : ref,
            commit: { verification: { verified: state.verified } },
          },
        }),
        compareCommitsWithBasehead: async ({ basehead }) => ({
          data: {
            merge_base_commit: { sha: OLD },
            status:
              basehead === `${UPSTREAM}...${MAIN}`
                ? state.contained
                  ? "ahead"
                  : "diverged"
                : "ahead",
          },
        }),
        merge: async ({ head }) => {
          state.calls.push(["merge", head]);
          if (state.conflict && head === UPSTREAM)
            throw Object.assign(new Error("conflict"), { status: 409 });
          const before = state.branches["sync/upstream-nightly"];
          if (head === MAIN || before === CANDIDATE) return { status: 204 };
          state.branches["sync/upstream-nightly"] = CANDIDATE;
          if (state.stale) state.branches.main = OLD;
          return {
            status: 201,
            data: {
              sha: CANDIDATE,
              parents: [{ sha: state.mergeRace ? OLD : before }, { sha: head }],
            },
          };
        },
      },
      git: {
        createRef: async ({ ref, sha }) => {
          state.calls.push(["createRef", ref, sha]);
          state.branches[ref.slice(11)] = sha;
        },
      },
      pulls: {
        list: async () => ({ data: state.pull ? [state.pull] : [] }),
        create: async (params) => {
          state.calls.push(["pr", params]);
          state.pull = {
            number: 7,
            html_url: `https://github.com/${repository}/pull/7`,
            head: { sha: CANDIDATE },
            base: { sha: MAIN },
          };
          return { data: state.pull };
        },
        update: async () => ({ data: state.pull }),
      },
      actions: {
        listWorkflowRuns: async () => ({
          data: { workflow_runs: state.existingRuns ? [{ head_sha: CANDIDATE }] : [] },
        }),
        createWorkflowDispatch: async (params) => {
          state.calls.push(["dispatch", params]);
        },
      },
    },
  };
  const input = {
    github,
    context: {
      repo: { owner: "alexander-cato", repo: "t3code-next" },
      ref: "refs/heads/main",
      sha: MAIN,
    },
    token: "test-token",
    checks: async () => undefined,
    conflictsOf: ({ base, ours, theirs }) => {
      state.calls.push(["conflicts", base, ours, theirs]);
      return ["apps/desktop/src/app/DesktopApp.test.ts"];
    },
    push: async ({ sha, expectedSha }) => {
      assert.equal(expectedSha, OLD);
      state.calls.push(["push", sha]);
      state.branches["upstream/nightly"] = sha;
    },
  };
  return { state, input };
}
test("selects only published nightly releases", () => {
  assert.equal(
    selectNightly([
      { tag_name: "v1.2.3", draft: false, published_at: "2026-11-15" },
      { tag_name: "v1.2.3-nightly.20261114.1", draft: false, published_at: "2026-11-14" },
      { tag_name: "v1.2.3-nightly.20261115.1", draft: true, published_at: "2026-11-15" },
    ]).tag_name,
    "v1.2.3-nightly.20261114.1",
  );
});
test("mirrors exact upstream, builds a signed candidate, opens PR and explicitly dispatches every required check", async () => {
  const { state, input } = fixture();
  const result = await syncUpstreamNightly(input);
  assert.equal(result.candidate, CANDIDATE);
  assert.equal(state.branches.main, MAIN);
  assert.equal(state.branches["upstream/nightly"], UPSTREAM);
  const dispatched = state.calls
    .filter(([kind]) => kind === "dispatch")
    .map(([, parameters]) => parameters);
  assert.deepEqual(
    dispatched.map((item) => item.workflow_id),
    ["ci.yml", "agent-context-budget.yml", "security.yml"],
  );
  for (const dispatch of dispatched)
    assert.deepEqual(dispatch.inputs, {
      expected_sha: CANDIDATE,
      base_sha: MAIN,
      pull_request: "7",
    });
  assert.equal(state.calls.filter(([kind]) => kind === "createRef").length, 1);
});
test("does no CI work for already incorporated releases or existing candidate runs; manual retry reruns them all", async () => {
  const { state, input } = fixture();
  state.contained = true;
  assert.equal((await syncUpstreamNightly(input)).changed, false);
  assert.equal(
    state.calls.some(([kind]) => kind === "dispatch" || kind === "pr"),
    false,
  );
  state.contained = false;
  state.existingRuns = true;
  await syncUpstreamNightly(input);
  assert.equal(
    state.calls.some(([kind]) => kind === "dispatch"),
    false,
  );
  await syncUpstreamNightly({ ...input, retry: true });
  assert.equal(state.calls.filter(([kind]) => kind === "dispatch").length, 3);
});
test("does not propose or dispatch an unverified or raced candidate", async () => {
  for (const field of ["verified", "stale", "mergeRace"]) {
    const { state, input } = fixture();
    state[field] = field !== "verified";
    await assert.rejects(syncUpstreamNightly(input));
    assert.equal(
      state.calls.some(([kind]) => kind === "dispatch" || kind === "pr"),
      false,
    );
  }
});
test("reports a conflict once in an assigned issue, waits without retrying it, and closes it once resolved", async () => {
  const { state, input } = fixture();
  state.conflict = true;
  assert.match((await syncUpstreamNightly(input)).reason, /conflicts\. Resolution needed: #100/);
  assert.deepEqual(
    state.calls.filter(([kind]) => kind === "issue"),
    [["issue", ["alexander-cato"]]],
  );
  assert.deepEqual(
    state.calls.find(([kind]) => kind === "conflicts"),
    ["conflicts", OLD, MAIN, UPSTREAM],
  );
  assert.match(state.issues[0].body, /- `apps\/desktop\/src\/app\/DesktopApp\.test\.ts`/);
  const merges = () => state.calls.filter(([kind]) => kind === "merge").length;
  const attempted = merges();
  assert.match(
    (await syncUpstreamNightly(input)).reason,
    /Waiting for the conflict resolution in #100/,
  );
  assert.equal(merges(), attempted);
  await syncUpstreamNightly({ ...input, retry: true });
  assert.equal(merges(), attempted + 2);
  state.conflict = false;
  state.branches["sync/upstream-nightly"] = OLD;
  assert.equal((await syncUpstreamNightly(input)).changed, true);
  assert.equal(state.issues[0].state, "closed");
  assert.equal(state.calls.filter(([kind]) => kind === "issue").length, 1);
});

test("reports a failed required check in the blocked issue, with or without automatic merging, until a rerun passes", async () => {
  const results = {
    failed: {
      merged: false,
      failed: true,
      reason: "Agent context budget failed on the exact candidate.",
    },
    rerunning: {
      merged: false,
      waiting: true,
      reason: "Waiting for Agent context budget on the exact candidate.",
    },
    passed: undefined,
  };
  for (const autoMerge of [true, false]) {
    const { state, input } = fixture();
    let current;
    const status = async () =>
      autoMerge
        ? (current ?? { merged: false, reason: "Waiting for a Codex code review." })
        : current;
    const run = (result) => {
      current = results[result];
      return syncUpstreamNightly({ ...input, autoMerge, review: status, checks: status });
    };
    assert.match((await run("failed")).review.reason, /Fix needed: #100$/);
    assert.match(state.issues[0].body, /pull\/7/);
    await run("rerunning");
    assert.equal(state.issues[0].state, "open");
    await run("failed");
    assert.equal(state.calls.filter(([kind]) => kind.startsWith("issue")).length, 1);
    await run("passed");
    assert.equal(state.issues[0].state, "closed");
  }
});

test("mirrors divergent upstream blobs from a partial fork checkout", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "t3-nightly-mirror-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const upstream = join(directory, "upstream");
  const forkSource = join(directory, "fork");
  const fork = join(directory, "fork.git");
  const checkout = join(directory, "checkout");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const execFileSync = childProcess.execFileSync;
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  git(directory, "init", "--initial-branch=main", upstream);
  git(upstream, "config", "user.name", "Nightly test");
  git(upstream, "config", "user.email", "nightly@example.invalid");
  git(upstream, "config", "uploadpack.allowFilter", "true");
  writeFileSync(join(upstream, "base.txt"), "Existing fork content\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "Base");
  const base = git(upstream, "rev-parse", "HEAD");
  git(directory, "clone", upstream, forkSource);
  git(forkSource, "config", "user.name", "Nightly test");
  git(forkSource, "config", "user.email", "nightly@example.invalid");
  writeFileSync(join(forkSource, "base.txt"), "Fork-only content\n");
  git(forkSource, "commit", "-am", "Fork changes");
  const forkMain = git(forkSource, "rev-parse", "HEAD");
  git(directory, "clone", "--bare", forkSource, fork);
  git(fork, "config", "uploadpack.allowFilter", "true");
  git(fork, "update-ref", "refs/heads/upstream/nightly", base);
  writeFileSync(join(upstream, "base.txt"), "New upstream content absent from the fork\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "Nightly");
  const sha = git(upstream, "rev-parse", "HEAD");
  git(
    directory,
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    "--depth=1",
    pathToFileURL(fork).href,
    checkout,
  );

  const modulePath = require.resolve("./sync-upstream-nightly.cjs");
  const cachedModule = require.cache[modulePath];
  t.after(() => {
    require.cache[modulePath] = cachedModule;
  });
  delete require.cache[modulePath];
  t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    return execFileSync(
      command,
      args.map((argument) => {
        if (argument === "https://github.com/pingdotgg/t3code.git")
          return pathToFileURL(upstream).href;
        if (argument === "https://github.com/alexander-cato/t3code-next.git")
          return pathToFileURL(fork).href;
        return argument;
      }),
      {
        ...options,
        cwd: checkout,
        env: { ...options.env, ...env },
      },
    );
  });
  const { pushMirror } = require(modulePath);
  pushMirror({ sha, expectedSha: base, token: "fixture-token" });
  assert.equal(git(fork, "rev-parse", "refs/heads/upstream/nightly"), sha);
  assert.equal(
    git(fork, "show", "upstream/nightly:base.txt"),
    "New upstream content absent from the fork",
  );
  assert.equal(git(fork, "rev-parse", "main"), forkMain);
  assert.equal(git(fork, "show", "main:base.txt"), "Fork-only content");
});
