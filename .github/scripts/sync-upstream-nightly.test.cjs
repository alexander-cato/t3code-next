const assert = require("node:assert/strict");
const test = require("node:test");
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
  };
  const github = {
    paginate: async () => [
      {
        tag_name: "v0.1.10-nightly.20261114.4669",
        draft: false,
        published_at: "2026-11-14T03:00:00Z",
      },
    ],
    rest: {
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
          if (state.conflict) throw Object.assign(new Error("conflict"), { status: 409 });
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
test("mirrors exact upstream, builds a signed candidate, opens PR and explicitly dispatches both required checks", async () => {
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
    ["ci.yml", "agent-context-budget.yml"],
  );
  for (const dispatch of dispatched)
    assert.deepEqual(dispatch.inputs, {
      expected_sha: CANDIDATE,
      base_sha: MAIN,
      pull_request: "7",
    });
  assert.equal(state.calls.filter(([kind]) => kind === "createRef").length, 1);
});
test("does no CI work for already incorporated releases or existing candidate runs; manual retry reruns both", async () => {
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
  assert.equal(state.calls.filter(([kind]) => kind === "dispatch").length, 2);
});
test("does not propose or dispatch an unverified, conflicted, or raced candidate", async () => {
  for (const field of ["verified", "conflict", "stale", "mergeRace"]) {
    const { state, input } = fixture();
    state[field] = field !== "verified";
    await assert.rejects(syncUpstreamNightly(input));
    assert.equal(
      state.calls.some(([kind]) => kind === "dispatch" || kind === "pr"),
      false,
    );
  }
});
