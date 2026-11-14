const assert = require("node:assert/strict");
const test = require("node:test");
const { nextVersion, resolveRelease } = require("./fork-release-plan.cjs");
const sha = "a".repeat(40);
const previous = "b".repeat(40);
function fixture() {
  const state = {
    ref: sha,
    protected: true,
    verified: true,
    latest: "success",
    current: [],
    legacy: [{ tag_name: "v0.1.10-nightly.20261114.391" }],
    ancestry: "ahead",
  };
  const github = {
    rest: {
      repos: {
        getBranch: async () => ({
          data: { protected: state.protected, commit: { sha: state.ref } },
        }),
        getCommit: async ({ ref }) => ({
          data: {
            sha: ref.startsWith("v") ? previous : ref,
            commit: { verification: { verified: state.verified } },
            committer: { login: "web-flow" },
          },
        }),
        listReleases: () => {},
        compareCommitsWithBasehead: async () => ({ data: { status: state.ancestry } }),
        getContent: async () => ({
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from('{"version":"0.1.9"}').toString("base64"),
          },
        }),
      },
      actions: {
        listWorkflowRuns: async () => ({
          data: {
            workflow_runs: [
              {
                id: 2,
                status: "completed",
                conclusion: state.latest,
                head_sha: sha,
                head_repository: { full_name: "alexander-cato/t3code-next" },
              },
              {
                id: 1,
                status: "completed",
                conclusion: "success",
                head_sha: sha,
                head_repository: { full_name: "alexander-cato/t3code-next" },
              },
            ],
          },
        }),
      },
    },
    paginate: async (_method, params) => (params.repo === "t3code" ? state.legacy : state.current),
  };
  const context = {
    repo: { owner: "alexander-cato", repo: "t3code-next" },
    ref: "refs/heads/main",
    sha,
    eventName: "workflow_dispatch",
    payload: {},
  };
  return { state, github, context, now: new Date("2026-11-14T10:00:00Z") };
}

test("version increases across old and successor releases, including drafts and clock rollback", () => {
  const now = new Date("2026-11-14T10:00:00Z");
  assert.equal(
    nextVersion("0.1.9", [{ tag_name: "v0.1.10-nightly.20261114.391" }], now),
    "0.1.10-nightly.20261114.392",
  );
  assert.equal(
    nextVersion("0.1.9", [{ tag_name: "v0.1.10-nightly.20261115.402", draft: true }], now),
    "0.1.10-nightly.20261115.403",
  );
  assert.equal(
    nextVersion("0.1.9", [{ tag_name: "v0.2.0-nightly.20261114.5" }], now),
    "0.2.0-nightly.20261114.6",
  );
  assert.equal(nextVersion("0.1.9", [{ tag_name: "v0.2.0" }], now), "0.2.1-nightly.20261114.1");
  assert.equal(
    nextVersion("0.1.9", [{ tag_name: "v0.1.10-nightly.20261112.346" }], now),
    "0.1.10-nightly.20261114.1",
  );
});

test("accepts a verified normal GitHub merge commit, pins main, and uses both release histories", async () => {
  const input = fixture();
  assert.deepEqual(await resolveRelease(input), {
    build: true,
    ref: sha,
    previousRef: undefined,
    version: "0.1.10-nightly.20261114.392",
    tag: "v0.1.10-nightly.20261114.392",
  });
  input.state.ref = previous;
  assert.equal((await resolveRelease(input)).build, false);
});

test("rejects an unsigned commit, unprotected main, failed latest CI, and untrusted workflow events", async () => {
  for (const [field, value, pattern] of [
    ["verified", false, /verified/],
    ["protected", false, /protected/],
    ["latest", "failure", /latest CI/],
  ]) {
    const input = fixture();
    input.state[field] = value;
    await assert.rejects(resolveRelease(input), pattern);
  }
  const input = fixture();
  input.context.eventName = "workflow_run";
  input.context.payload.workflow_run = {
    event: "pull_request",
    head_branch: "main",
    conclusion: "success",
    head_repository: { full_name: "attacker/repo" },
    head_sha: sha,
  };
  await assert.rejects(resolveRelease(input), /manual main dispatch/);
  input.context.ref = "refs/heads/feature";
  await assert.rejects(resolveRelease(input), /protected main branch/);
});

test("refuses release rollback and fails closed when legacy history cannot be read", async () => {
  const input = fixture();
  input.state.current = [
    {
      tag_name: "v0.1.10-nightly.20261114.400",
      draft: false,
      published_at: "2026-11-14T00:00:00Z",
    },
  ];
  input.state.ancestry = "behind";
  await assert.rejects(resolveRelease(input), /older than/);
  input.github.paginate = async () => {
    throw new Error("API unavailable");
  };
  await assert.rejects(resolveRelease(input), /API unavailable/);
});
