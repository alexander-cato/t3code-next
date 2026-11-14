const test = require("node:test");
const assert = require("node:assert/strict");
const { validateNightlyDispatch } = require("./validate-nightly-dispatch.cjs");
const head = "a".repeat(40);
const base = "b".repeat(40);
function fixture() {
  const pull = {
    state: "open",
    head: {
      ref: "sync/upstream-nightly",
      sha: head,
      repo: { full_name: "alexander-cato/t3code-next" },
    },
    base: { ref: "main", sha: base },
    labels: [],
  };
  const input = {
    context: {
      repo: { owner: "alexander-cato", repo: "t3code-next" },
      eventName: "workflow_dispatch",
      ref: "refs/heads/sync/upstream-nightly",
      sha: head,
    },
    expectedSha: head,
    baseSha: base,
    pullNumber: "7",
    github: {
      rest: {
        pulls: { get: async () => ({ data: pull }) },
        repos: { getBranch: async () => ({ data: { commit: { sha: base } } }) },
      },
    },
  };
  return { pull, input };
}
test("validates exact candidate and main base; uses actual PR labels for context allowance", async () => {
  const { pull, input } = fixture();
  assert.deepEqual(await validateNightlyDispatch(input), { allowIncrease: false });
  pull.labels.push({ name: "agent-context-increase" });
  assert.deepEqual(await validateNightlyDispatch(input), { allowIncrease: true });
  input.context.eventName = "pull_request";
  assert.equal(await validateNightlyDispatch(input), undefined);
});
test("rejects stale candidate, changed base, another repository, closed PR, or wrong branch", async () => {
  for (const mutate of [
    ({ input }) => (input.expectedSha = base),
    ({ pull }) => (pull.base.sha = head),
    ({ pull }) => (pull.head.repo.full_name = "attacker/repo"),
    ({ pull }) => (pull.state = "closed"),
    ({ input }) => (input.context.ref = "refs/heads/upstream/nightly"),
    ({ input }) => (input.pullNumber = "1; echo unsafe"),
  ]) {
    const fixtureValue = fixture();
    mutate(fixtureValue);
    await assert.rejects(validateNightlyDispatch(fixtureValue.input));
  }
});
