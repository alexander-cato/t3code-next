const assert = require("node:assert/strict");
const test = require("node:test");
const { mergeReviewedNightly } = require("./fork-sync-review.cjs");
const HEAD = "a".repeat(40),
  BASE = "b".repeat(40),
  UPSTREAM = "d".repeat(40),
  RELEASE = "e".repeat(40);
function fixture() {
  const state = {
    checks: ["Check", "Agent context budget", "Security check"].map((name) => ({
      name,
      head_sha: HEAD,
      app: { id: 15368 },
      id: 1,
      status: "completed",
      conclusion: "success",
    })),
    threads: [],
    // Blob per path at each ref; a missing path does not exist there.
    blobs: {
      [HEAD]: { "upstream.ts": "1", "fork.ts": "2", "added.ts": "3" },
      [UPSTREAM]: { "upstream.ts": "1", "fork.ts": "9" },
    },
    base: BASE,
    protected: true,
    merged: [],
    page: 0,
    secondPage: false,
    signed: true,
    // An unsigned upstream release commit, as t3-code-bot publishes them.
    release: { sha: RELEASE, commit: { verification: { verified: false } } },
    upstreamHas: [RELEASE],
  };
  const listForRef = () => {};
  const github = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            state: "open",
            draft: false,
            title: "chore(sync): nightly",
            head: {
              sha: HEAD,
              ref: "sync/upstream-nightly",
              repo: { full_name: "alexander-cato/t3code-next" },
            },
            base: { sha: BASE, ref: "main" },
          },
        }),
      },
      repos: {
        getBranch: async () => ({
          data: { protected: state.protected, commit: { sha: state.base } },
        }),
        getContent: async ({ path, ref }) => {
          const sha = state.blobs[ref][path];
          if (!sha) throw Object.assign(new Error("missing"), { status: 404 });
          return { data: { sha } };
        },
        compareCommitsWithBasehead: async ({ basehead }) => {
          const [from, to] = basehead.split("...");
          if (to === UPSTREAM)
            return { data: { status: state.upstreamHas.includes(from) ? "ahead" : "diverged" } };
          const commits = [
            state.release,
            { sha: HEAD, commit: { verification: { verified: state.signed } } },
          ];
          return { data: { total_commits: commits.length, commits } };
        },
        getCommit: async () => ({
          data: { sha: HEAD, commit: { verification: { verified: true } } },
        }),
      },
      checks: { listForRef },
    },
    paginate: async () => state.checks,
    graphql: async () => {
      state.page++;
      const more = state.secondPage && state.page === 1;
      return {
        repository: {
          pullRequest: {
            headRefOid: HEAD,
            baseRefOid: BASE,
            reviewThreads: {
              nodes: more ? [] : state.threads,
              pageInfo: { hasNextPage: more, endCursor: "next" },
            },
          },
        },
      };
    },
  };
  const merger = {
    rest: {
      pulls: {
        merge: async (request) => {
          state.merged.push(request);
          return { data: { merged: true, sha: "c".repeat(40), message: "Merged" } };
        },
      },
    },
  };
  return {
    state,
    input: { github, merger, pullNumber: 7, head: HEAD, base: BASE, upstream: UPSTREAM },
  };
}
test("merges a candidate whose checks pass, including upstream's unsigned commits, without a Codex review", async () => {
  const { state, input } = fixture();
  assert.equal((await mergeReviewedNightly(input)).merged, true);
  assert.deepEqual(state.merged, [
    {
      owner: "alexander-cato",
      repo: "t3code-next",
      pull_number: 7,
      sha: HEAD,
      merge_method: "merge",
      commit_title: "chore(sync): nightly",
    },
  ]);
});
test("merges past unresolved threads on files the fork carries exactly as upstream", async () => {
  const { state, input } = fixture();
  state.threads = [
    { isResolved: false, path: "upstream.ts" },
    { isResolved: true, path: "fork.ts" },
  ];
  assert.equal((await mergeReviewedNightly(input)).merged, true);
});
test("holds unresolved threads on files the fork changed or added", async () => {
  for (const path of ["fork.ts", "added.ts"]) {
    const { state, input } = fixture();
    state.threads = [
      { isResolved: false, path: "upstream.ts" },
      { isResolved: false, path },
    ];
    const result = await mergeReviewedNightly(input);
    assert.equal(result.blocked, true);
    assert.match(result.reason, new RegExp(`: ${path.replace(".", "\\.")}\\.$`));
    assert.equal(state.merged.length, 0);
  }
});
test("leaves the PR open for check, discussion, signature, or main races without relying on older success", async () => {
  const blocked = [
    (state) => state.checks.push({ ...state.checks[2], id: 2, conclusion: "failure" }),
    (state) => (state.threads = [{ isResolved: false, path: "fork.ts" }]),
    (state) => {
      state.threads = [{ isResolved: false, path: "fork.ts" }];
      state.secondPage = true;
    },
    (state) => (state.signed = false),
    (state) => (state.upstreamHas = []),
  ];
  for (const alter of [
    (state) => (state.checks = state.checks.filter((check) => check.name !== "Security check")),
    ...blocked,
    (state) => (state.checks[0].app.id = 1),
    (state) => (state.base = HEAD),
    (state) => (state.protected = false),
  ]) {
    const { state, input } = fixture();
    alter(state);
    const result = await mergeReviewedNightly(input);
    assert.equal(result.merged, false);
    assert.equal(result.blocked, blocked.includes(alter) || undefined);
    assert.equal(state.merged.length, 0);
  }
});
