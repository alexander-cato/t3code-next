const BOT_ID = 199175422;
const REPOSITORY = { owner: "alexander-cato", repo: "t3code-next" };

function completedCodeReview(comments, head) {
  const summaries = comments
    .filter(
      (comment) =>
        comment.user?.id === BOT_ID &&
        comment.user?.type === "Bot" &&
        comment.user?.login === "chatgpt-codex-connector[bot]" &&
        typeof comment.body === "string" &&
        comment.body.includes("<!-- codex-review-state:v1 "),
    )
    .sort((a, b) => b.id - a.id);
  const body = summaries[0]?.body;
  if (!body || body.length > 100_000) return false;
  const matches = [...body.matchAll(/<!-- codex-review-state:v1 ([^\n]+?) -->/g)];
  if (matches.length !== 1 || matches[0][1].length > 16_384) return false;
  let state;
  try {
    state = JSON.parse(matches[0][1]);
  } catch {
    return false;
  }
  const review = state?.code_review;
  return review?.commit_sha === head && review.status === "completed" ? review : undefined;
}

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

async function mergeReviewedNightly({ github, merger, pullNumber, head, base }) {
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
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...REPOSITORY,
    issue_number: pullNumber,
    per_page: 100,
  });
  const review = completedCodeReview(comments, head);
  if (!review) return pending("Waiting for a completed current-head Codex code review.");
  // Codex keeps reporting findings after their threads are resolved, so resolved threads decide.
  let threadCount = 0;
  let after = null;
  let done = false;
  for (let page = 0; page < 20; page++) {
    const result = await github.graphql(
      `query($owner:String!,$repo:String!,$number:Int!,$after:String) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
        headRefOid baseRefOid reviewThreads(first:100,after:$after) {
          nodes { isResolved } pageInfo { hasNextPage endCursor }
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
    if (threads.nodes.some((thread) => thread?.isResolved !== true))
      return {
        merged: false,
        blocked: true,
        reason: "Review findings need a fix or a written dismissal, then a resolved thread.",
      };
    threadCount += threads.nodes.length;
    if (threads.pageInfo?.hasNextPage === false) {
      done = true;
      break;
    }
    if (!threads.pageInfo?.endCursor || threads.pageInfo.endCursor === after)
      return pending("Review pagination is incomplete.");
    after = threads.pageInfo.endCursor;
  }
  if (!done) return pending("Review thread list exceeds the verification limit.");
  if (review.has_unresolved_findings !== false && threadCount === 0)
    return pending("Codex reported findings without review threads to resolve.");
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

module.exports = { completedCodeReview, mergeReviewedNightly, requiredChecks };
