const assert = require("node:assert/strict");
const test = require("node:test");
const childProcess = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  resolveCatalogConflicts,
  selectNightly,
  syncUpstreamNightly,
} = require("./sync-upstream-nightly.cjs");
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
        createBlob: async ({ content }) => {
          state.calls.push(["blob", content]);
          return { data: { sha: state.blobSha ?? "e".repeat(40) } };
        },
        createTree: async ({ base_tree, tree }) => {
          state.calls.push(["tree", base_tree, tree]);
          return { data: { sha: state.treeSha ?? "f".repeat(40) } };
        },
        createCommit: async ({ message, tree, parents }) => {
          state.calls.push(["commit", message, tree, parents]);
          return { data: { sha: CANDIDATE } };
        },
        updateRef: async ({ ref, sha, force }) => {
          state.calls.push(["updateRef", ref, sha, force]);
          state.branches[ref.slice(6)] = sha;
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
      return state.conflicts ?? ["apps/desktop/src/app/DesktopApp.test.ts"];
    },
    resolveConflicts: () => state.resolution,
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

test("commits a catalog-only conflict merged locally, and blocks when GitHub's tree differs", async () => {
  const catalog = "apps/web/src/i18n/translations/en.json";
  const resolution = {
    baseTree: "1".repeat(40),
    tree: "f".repeat(40),
    files: [catalog],
    entries: [
      { path: catalog, mode: "100644", type: "blob", sha: "e".repeat(40), content: "e30K" },
      { path: "upstream.ts", mode: "100644", type: "blob", sha: "2".repeat(40) },
      { path: "removed.ts", mode: "100644", type: "blob", sha: null },
    ],
  };
  const { state, input } = fixture();
  Object.assign(state, { conflict: true, conflicts: [catalog], resolution });
  const result = await syncUpstreamNightly(input);
  assert.equal(result.candidate, CANDIDATE);
  assert.deepEqual(
    state.calls.filter(([kind]) => kind === "blob"),
    [["blob", "e30K"]],
  );
  const [, baseTree, tree] = state.calls.find(([kind]) => kind === "tree");
  assert.equal(baseTree, resolution.baseTree);
  assert.deepEqual(
    tree.map((entry) => entry.sha),
    ["e".repeat(40), "2".repeat(40), null],
  );
  const [, message, , parents] = state.calls.find(([kind]) => kind === "commit");
  assert.match(
    message,
    /^chore\(sync\): merge v0\.1\.10-nightly\.20261114\.4669\n\n.*\n- apps\/web/s,
  );
  assert.deepEqual(parents, [MAIN, UPSTREAM]);
  assert.deepEqual(
    state.calls.find(([kind]) => kind === "updateRef"),
    ["updateRef", "heads/sync/upstream-nightly", CANDIDATE, false],
  );
  assert.equal(state.issues.length, 0);

  for (const alter of [
    (s) => (s.treeSha = "0".repeat(40)),
    (s) => (s.blobSha = "0".repeat(40)),
    (s) => (s.conflicts = [catalog, "apps/web/src/App.tsx"]),
    (s) => (s.resolution = undefined),
  ]) {
    const { state, input } = fixture();
    Object.assign(state, { conflict: true, conflicts: [catalog], resolution });
    alter(state);
    assert.match((await syncUpstreamNightly(input)).reason, /Resolution needed: #100/);
    assert.equal(
      state.calls.some(([kind]) => kind === "updateRef"),
      false,
    );
  }
});

test("resolves catalog-only conflicts into the tree a full merge would build", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "t3-nightly-catalog-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) =>
    childProcess.execFileSync("git", args, { cwd: directory, env, encoding: "utf8" }).trim();
  const catalog = "apps/web/src/i18n/translations/en.json";
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      childProcess.execFileSync("mkdir", ["-p", join(directory, path, "..")]);
      writeFileSync(join(directory, path), text);
    }
    git("add", "-A");
    git("commit", "-qm", "change");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Nightly test");
  git("config", "user.email", "nightly@example.invalid");
  const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
  const base = write({
    [catalog]: '{\n  "a": "A"\n}\n',
    "shared.txt": `${lines.join("\n")}\n`,
    "gone.txt": "upstream deletes this\n",
  });
  const ours = write({
    [catalog]: '{\n  "a": "A",\n  "fork": "Fork"\n}\n',
    "shared.txt": `${["fork 0", ...lines.slice(1)].join("\n")}\n`,
  });
  git("checkout", "-q", base);
  git("rm", "-q", "gone.txt");
  const theirs = write({
    [catalog]: '{\n  "a": "A",\n  "up": ["x", { "i": 1 }]\n}\n',
    "shared.txt": `${[...lines.slice(0, 7), "upstream 7"].join("\n")}\n`,
    "new.txt": "upstream adds this\n",
  });
  const run = (fn) => {
    const previous = process.cwd();
    process.chdir(directory);
    try {
      return fn();
    } finally {
      process.chdir(previous);
    }
  };
  const resolution = run(() => resolveCatalogConflicts({ base, ours, theirs }));
  assert.deepEqual(resolution.files, [catalog]);
  assert.equal(
    git("cat-file", "blob", `${resolution.tree}:${catalog}`),
    '{\n  "a": "A",\n  "up": ["x", { "i": 1 }],\n  "fork": "Fork"\n}',
  );
  assert.equal(
    git("cat-file", "blob", `${resolution.tree}:shared.txt`),
    ["fork 0", ...lines.slice(1, 7), "upstream 7"].join("\n"),
  );
  const byPath = Object.fromEntries(resolution.entries.map((entry) => [entry.path, entry]));
  assert.deepEqual(Object.keys(byPath).sort(), [catalog, "gone.txt", "new.txt", "shared.txt"]);
  assert.equal(byPath["gone.txt"].sha, null);
  // Blobs GitHub already has from the nightly are referenced, not uploaded.
  assert.equal(byPath["new.txt"].content, undefined);
  for (const path of [catalog, "shared.txt"])
    assert.equal(
      Buffer.from(byPath[path].content, "base64").toString("utf8"),
      `${git("cat-file", "blob", `${resolution.tree}:${path}`)}\n`,
    );
  // A key changed differently on both sides, or a conflict outside the catalogs, waits for a person.
  git("checkout", "-q", ours);
  const forkKey = write({ [catalog]: '{\n  "a": "Fork A",\n  "fork": "Fork"\n}\n' });
  const forkCode = write({ "shared.txt": `${[...lines.slice(0, 7), "fork 7"].join("\n")}\n` });
  git("checkout", "-q", theirs);
  const upstreamKey = write({
    [catalog]: '{\n  "a": "Upstream A",\n  "up": ["x", { "i": 1 }]\n}\n',
  });
  for (const [left, right] of [
    [forkKey, upstreamKey],
    [forkCode, theirs],
  ])
    assert.equal(
      run(() => resolveCatalogConflicts({ base, ours: left, theirs: right })),
      undefined,
    );
});

test("reports a failed required check in the blocked issue, with or without automatic merging, until a rerun passes", async () => {
  const results = {
    failed: {
      merged: false,
      blocked: true,
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
