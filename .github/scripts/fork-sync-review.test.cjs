const assert = require("node:assert/strict");
const test = require("node:test");
const { completedCodeReview, mergeReviewedNightly } = require("./fork-sync-review.cjs");
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
    // Codex reports a completed security review with null findings; the merger must not need it.
    security_review: {
      commit_sha: BASE,
      status: "completed",
      has_any_findings: null,
      has_unresolved_findings: null,
    },
  };
}
test("requires a completed current-head code review from the trusted numeric bot identity", () => {
  assert.ok(completedCodeReview([summary(reviews())], HEAD));
  for (const mutate of [
    (value) => (value.code_review.status = "running"),
    (value) => (value.code_review.commit_sha = BASE),
    (value) => delete value.code_review,
  ]) {
    const state = reviews();
    mutate(state);
    assert.ok(!completedCodeReview([summary(state)], HEAD));
  }
  assert.ok(
    !completedCodeReview(
      [summary(reviews(), { user: { id: 1, login: "chatgpt-codex-connector[bot]", type: "Bot" } })],
      HEAD,
    ),
  );
  assert.ok(!completedCodeReview([summary(reviews()), summary({}, { id: 2 })], HEAD));
  for (const body of [
    "<!-- codex-review-state:v1 invalid -->",
    "x".repeat(100001),
    summary(reviews()).body.repeat(2),
  ]) {
    assert.ok(!completedCodeReview([summary(reviews(), { body })], HEAD));
  }
});
function fixture() {
  const state = {
    review: reviews(),
    checks: ["Check", "Agent context budget", "Security check"].map((name) => ({
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
    // Codex's inline review on the head, plus a body-only finding on an older candidate.
    reviews: [
      { id: 1, user: { id: 199175422 }, commit_id: HEAD },
      { id: 2, user: { id: 199175422 }, commit_id: BASE },
    ],
    reviewComments: { 1: [{ id: 10 }], 2: [] },
    signed: true,
  };
  const listComments = () => {},
    listForRef = () => {},
    listReviews = () => {},
    listCommentsForReview = () => {};
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
        listReviews,
        listCommentsForReview,
      },
      repos: {
        getBranch: async () => ({
          data: { protected: state.protected, commit: { sha: state.base } },
        }),
        compareCommitsWithBasehead: async () => ({
          data: {
            total_commits: 1,
            commits: [{ sha: HEAD, commit: { verification: { verified: state.signed } } }],
          },
        }),
        getCommit: async () => ({
          data: { sha: HEAD, commit: { verification: { verified: true } } },
        }),
      },
      issues: { listComments },
      checks: { listForRef },
    },
    paginate: async (method, request) => {
      if (method === listComments) return [summary(state.review)];
      if (method === listReviews) return state.reviews;
      if (method === listCommentsForReview) return state.reviewComments[request.review_id];
      return state.checks;
    },
    graphql: async () => {
      state.page++;
      return {
        repository: {
          pullRequest: {
            headRefOid: HEAD,
            baseRefOid: BASE,
            reviewThreads: {
              nodes: state.noThreads
                ? []
                : [{ isResolved: state.resolved || (state.secondPage && state.page === 1) }],
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
  // Codex still reports findings after their threads are resolved.
  state.review.code_review.has_unresolved_findings = true;
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
test("merges past a body-only head review when Codex reports no findings", async () => {
  const { state, input } = fixture();
  state.reviewComments[1] = [];
  assert.equal((await mergeReviewedNightly(input)).merged, true);
});
test("leaves the PR open for review, check, discussion, or main races without relying on older success", async () => {
  // A failed check is reported as blocked even while the Codex review is still running.
  const blocked = [
    (state) => state.checks.push({ ...state.checks[2], id: 2, conclusion: "failure" }),
    (state) => {
      state.review.code_review.status = "running";
      state.checks.push({ ...state.checks[0], id: 2, conclusion: "failure" });
    },
    (state) => (state.resolved = false),
    (state) => {
      state.resolved = false;
      state.secondPage = true;
    },
    (state) => {
      state.review.code_review.has_unresolved_findings = true;
      state.reviewComments[1] = [];
    },
    (state) => (state.signed = false),
  ];
  for (const alter of [
    (state) => (state.review.code_review.status = "running"),
    (state) => (state.checks = state.checks.filter((check) => check.name !== "Security check")),
    ...blocked,
    (state) => {
      state.review.code_review.has_unresolved_findings = true;
      state.noThreads = true;
    },
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
