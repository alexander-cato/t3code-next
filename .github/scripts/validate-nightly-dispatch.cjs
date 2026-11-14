async function validateNightlyDispatch({ github, context, expectedSha, baseSha, pullNumber }) {
  if (context.eventName !== "workflow_dispatch") return undefined;
  if (
    `${context.repo.owner}/${context.repo.repo}` !== "alexander-cato/t3code-next" ||
    context.ref !== "refs/heads/sync/upstream-nightly" ||
    !/^[a-f0-9]{40}$/.test(expectedSha) ||
    !/^[a-f0-9]{40}$/.test(baseSha) ||
    !/^[1-9][0-9]*$/.test(pullNumber) ||
    expectedSha !== context.sha
  ) {
    throw new Error("Dispatch must identify the exact nightly candidate SHA and PR base.");
  }
  const { data: pull } = await github.rest.pulls.get({
    ...context.repo,
    pull_number: Number(pullNumber),
  });
  const { data: main } = await github.rest.repos.getBranch({ ...context.repo, branch: "main" });
  if (
    pull.state !== "open" ||
    pull.head.sha !== expectedSha ||
    pull.base.sha !== baseSha ||
    main.commit.sha !== baseSha ||
    pull.base.ref !== "main" ||
    pull.head.ref !== "sync/upstream-nightly" ||
    pull.head.repo?.full_name !== "alexander-cato/t3code-next"
  ) {
    throw new Error("The nightly PR or its main base changed; rerun the nightly sync.");
  }
  return { allowIncrease: pull.labels.some((label) => label.name === "agent-context-increase") };
}
module.exports = { validateNightlyDispatch };
