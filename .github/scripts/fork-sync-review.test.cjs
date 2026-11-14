const assert = require("node:assert/strict");
const test = require("node:test");
const { completedReviews, mergeReviewedNightly } = require("./fork-sync-review.cjs");
const HEAD = "a".repeat(40),
  BASE = "b".repeat(40);
function summary(state, extra = {}) {
  return {
    id: 1,
    user: { id: 199175422, login: "chatgpt-codex-connector[bot]", type: "Bot" },
    body: `<!-- codex-review-state:v1 ${JSON.stringify(state)} -->`,
    ...extra,
  };
}
function reviews() {
  return {
    code_review: { commit_sha: HEAD, status: "completed", has_unresolved_findings: false },
    security_review: { commit_sha: HEAD, status: "completed", has_unresolved_findings: false },
  };
}
test("requires both current-head review states, trusted numeric bot identity, and explicit no-unresolved findings", () => {
  assert.equal(completedReviews([summary(reviews())], HEAD), true);
  for (const mutate of [
    (value) => (value.code_review.status = "running"),
    (value) => (value.security_review.commit_sha = BASE),
    (value) => (value.security_review.has_unresolved_findings = null),
    (value) => (value.code_review.has_unresolved_findings = true),
    (value) => delete value.security_review,
  ]) {
    const state = reviews();
    mutate(state);
    assert.equal(completedReviews([summary(state)], HEAD), false);
  }
  assert.equal(
    completedReviews(
      [summary(reviews(), { user: { id: 1, login: "chatgpt-codex-connector[bot]", type: "Bot" } })],
      HEAD,
    ),
    false,
  );
  assert.equal(completedReviews([summary(reviews()), summary({}, { id: 2 })], HEAD), false);
  for (const body of [
    "<!-- codex-review-state:v1 invalid -->",
    "x".repeat(100001),
    summary(reviews()).body.repeat(2),
  ]) {
    assert.equal(completedReviews([summary(reviews(), { body })], HEAD), false);
  }
});
function fixture() {
  const state = {
    review: reviews(),
    checks: ["Check", "Agent context budget"].map((name) => ({
      name,
      head_sha: HEAD,
      app: { id: 15368 },
      id: 1,
      status: "completed",
      conclusion: "success",
    })),
    resolved: true,
    base: BASE,
    protected: true,
    merged: [],
    page: 0,
    secondPage: false,
  };
  const listComments = () => {},
    listForRef = () => {};
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
        getCommit: async () => ({
          data: { sha: HEAD, commit: { verification: { verified: true } } },
        }),
      },
      issues: { listComments },
      checks: { listForRef },
    },
    paginate: async (method) => (method === listComments ? [summary(state.review)] : state.checks),
    graphql: async () => {
      state.page++;
      return {
        repository: {
          pullRequest: {
            headRefOid: HEAD,
            baseRefOid: BASE,
            reviewThreads: {
              nodes: [{ isResolved: state.resolved || (state.secondPage && state.page === 1) }],
              pageInfo: { hasNextPage: state.secondPage && state.page === 1, endCursor: "next" },
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
  return { state, input: { github, merger, pullNumber: 7, head: HEAD, base: BASE } };
}
test("merges only a fully reviewed candidate, pinning the head and using the App merge client", async () => {
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
test("leaves the PR open for review, check, discussion, or main races without relying on older success", async () => {
  for (const alter of [
    (state) => (state.review.security_review.status = "running"),
    (state) => state.checks.push({ ...state.checks[0], id: 2, conclusion: "failure" }),
    (state) => (state.checks[0].app.id = 1),
    (state) => (state.resolved = false),
    (state) => {
      state.resolved = false;
      state.secondPage = true;
    },
    (state) => (state.base = HEAD),
    (state) => (state.protected = false),
  ]) {
    const { state, input } = fixture();
    alter(state);
    assert.equal((await mergeReviewedNightly(input)).merged, false);
    assert.equal(state.merged.length, 0);
  }
});
