const REPOSITORY = { owner: "alexander-cato", repo: "t3code-next" };

// Returns undefined once every required check passed on the exact head.
async function requiredChecks({ github, head }) {
  const checks = await github.paginate(github.rest.checks.listForRef, {
    ...REPOSITORY,
    ref: head,
    per_page: 100,
  });
  // Codex security reviews report no pass or fail, so the owner's Security workflow gates instead.
  let waiting;
  for (const name of ["Check", "Agent context budget", "Security check"]) {
    const check = checks
      .filter((item) => item.name === name && item.head_sha === head && item.app?.id === 15368)
      .sort((a, b) => b.id - a.id)[0];
    if (check?.status === "completed" && check.conclusion !== "success")
      return { blocked: true, reason: `${name} failed on the exact candidate.` };
    if (check?.status !== "completed")
      waiting ??= { waiting: true, reason: `Waiting for ${name} on the exact candidate.` };
  }
  return waiting;
}

async function mergeReviewedNightly({ github, merger, pullNumber, head, base, upstream }) {
  const pending = (reason) => ({ merged: false, reason });
  const { data: pull } = await github.rest.pulls.get({ ...REPOSITORY, pull_number: pullNumber });
  if (
    pull.state !== "open" ||
    pull.draft ||
    pull.head.sha !== head ||
    pull.base.sha !== base ||
    pull.base.ref !== "main" ||
    pull.head.ref !== "sync/upstream-nightly" ||
    pull.head.repo?.full_name !== "alexander-cato/t3code-next"
  )
    return pending("Nightly PR is not the pinned ready candidate.");
  const checks = await requiredChecks({ github, head });
  if (checks) return { merged: false, ...checks };
  // Codex review is optional, and it reviews every upstream change in the nightly. A thread holds
  // the merge only on a file the fork carries differently from upstream.
  const unresolved = new Set();
  let after = null;
  let done = false;
  for (let page = 0; page < 20; page++) {
    const result = await github.graphql(
      `query($owner:String!,$repo:String!,$number:Int!,$after:String) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
        headRefOid baseRefOid reviewThreads(first:100,after:$after) {
          nodes { isResolved path } pageInfo { hasNextPage endCursor }
        }
      } }
    }`,
      { ...REPOSITORY, number: pullNumber, after },
    );
    const current = result.repository?.pullRequest;
    if (current?.headRefOid !== head || current.baseRefOid !== base)
      return pending("PR source or base changed during review verification.");
    const threads = current.reviewThreads;
    if (!Array.isArray(threads?.nodes)) return pending("Review threads are unavailable.");
    for (const thread of threads.nodes)
      if (thread?.isResolved !== true) unresolved.add(thread?.path ?? "");
    if (threads.pageInfo?.hasNextPage === false) {
      done = true;
      break;
    }
    if (!threads.pageInfo?.endCursor || threads.pageInfo.endCursor === after)
      return pending("Review pagination is incomplete.");
    after = threads.pageInfo.endCursor;
  }
  if (!done) return pending("Review thread list exceeds the verification limit.");
  const blobAt = async (path, ref) => {
    try {
      const { data } = await github.rest.repos.getContent({ ...REPOSITORY, path, ref });
      return Array.isArray(data) ? "directory" : data.sha;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  };
  const forkFiles = [];
  for (const path of unresolved)
    if (!path || (await blobAt(path, head)) !== (await blobAt(path, upstream)))
      forkFiles.push(path || "(no file)");
  if (forkFiles.length)
    return {
      merged: false,
      blocked: true,
      reason: `Review findings on fork changes need a fix or a written dismissal, then a resolved thread: ${forkFiles.join(", ")}.`,
    };
  // Main requires signed commits, so GitHub refuses the merge while any new commit is unsigned.
  for (let page = 1, seen = 0; ; page++) {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      ...REPOSITORY,
      basehead: `${base}...${head}`,
      per_page: 100,
      page,
    });
    const unsigned = data.commits.find((commit) => commit.commit?.verification?.verified !== true);
    if (unsigned)
      return {
        merged: false,
        blocked: true,
        reason: `Commit ${unsigned.sha.slice(0, 10)} is unsigned, and main requires signed commits. Merge the PR by hand with that rule briefly lifted.`,
      };
    seen += data.commits.length;
    if (data.commits.length === 0 || seen >= data.total_commits) break;
  }
  const { data: main } = await github.rest.repos.getBranch({ ...REPOSITORY, branch: "main" });
  const { data: source } = await github.rest.repos.getCommit({ ...REPOSITORY, ref: head });
  if (
    !main.protected ||
    main.commit.sha !== base ||
    source.sha !== head ||
    source.commit?.verification?.verified !== true
  ) {
    return pending("Protected main or the verified candidate changed before merge.");
  }
  const { data: merged } = await merger.rest.pulls.merge({
    ...REPOSITORY,
    pull_number: pullNumber,
    sha: head,
    merge_method: "merge",
    commit_title: pull.title,
  });
  return { merged: merged.merged === true, sha: merged.sha, reason: merged.message };
}

module.exports = { mergeReviewedNightly, requiredChecks };
