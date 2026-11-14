const { mergeReviewedNightly } = require("./fork-sync-review.cjs");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const REPOSITORY = { owner: "alexander-cato", repo: "t3code-next" };
const UPSTREAM = { owner: "pingdotgg", repo: "t3code" };
const MIRROR = "upstream/nightly";
const CANDIDATE = "sync/upstream-nightly";
const SHA = /^[a-f0-9]{40}$/;

function selectNightly(releases) {
  const result = releases
    .filter(
      (release) =>
        !release.draft &&
        /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(release.tag_name) &&
        Number.isFinite(Date.parse(release.published_at)),
    )
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!result) throw new Error("No published upstream nightly was found.");
  return result;
}

function pushMirror({ sha, expectedSha, token }) {
  const directory = mkdtempSync(join(tmpdir(), "t3-nightly-push-"));
  try {
    const askpass = join(directory, "askpass");
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token;; *) printf "%s\\n" "$NIGHTLY_PUSH_TOKEN";; esac\n',
      { mode: 0o700 },
    );
    const git = (...args) =>
      execFileSync("git", ["-c", "credential.helper=", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: askpass,
          NIGHTLY_PUSH_TOKEN: token,
        },
      }).trim();
    // The fork's partial-clone remote cannot supply newly published upstream objects.
    git(
      "fetch",
      "--no-tags",
      "--refetch",
      "--no-filter",
      "https://github.com/pingdotgg/t3code.git",
      sha,
    );
    if (git("rev-parse", "FETCH_HEAD") !== sha)
      throw new Error("Upstream fetch returned an unexpected SHA.");
    git(
      "push",
      `--force-with-lease=refs/heads/${MIRROR}:${expectedSha ?? ""}`,
      "https://github.com/alexander-cato/t3code-next.git",
      `${sha}:refs/heads/${MIRROR}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function syncUpstreamNightly({
  github,
  candidateGithub = github,
  context,
  retry = false,
  autoMerge = false,
  token,
  push = pushMirror,
}) {
  if (
    `${context.repo.owner}/${context.repo.repo}` !== "alexander-cato/t3code-next" ||
    context.ref !== "refs/heads/main"
  ) {
    throw new Error("Nightly sync only runs from the successor's main branch.");
  }
  const branch = async (name) => {
    try {
      return (await github.rest.repos.getBranch({ ...REPOSITORY, branch: name })).data.commit.sha;
    } catch (error) {
      if (error.status === 404) return undefined;
      throw error;
    }
  };
  const contains = async (base, head, repository = REPOSITORY) => {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      ...repository,
      basehead: `${base}...${head}`,
    });
    if (!["ahead", "identical", "behind", "diverged"].includes(data.status))
      throw new Error("Invalid ancestry result.");
    return ["ahead", "identical"].includes(data.status);
  };
  const verified = async (sha, repository = REPOSITORY) => {
    const { data } = await github.rest.repos.getCommit({ ...repository, ref: sha });
    if (!SHA.test(data.sha) || data.sha !== sha || !data.commit?.verification?.verified) {
      throw new Error(`Refusing unverified source commit ${sha}.`);
    }
  };
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...UPSTREAM,
    per_page: 100,
  });
  const nightly = selectNightly(releases);
  const { data: upstream } = await github.rest.repos.getCommit({
    ...UPSTREAM,
    ref: nightly.tag_name,
  });
  const sha = upstream.sha;
  await verified(sha, UPSTREAM);
  const main = await branch("main");
  if (!SHA.test(main) || main !== context.sha)
    throw new Error("main changed after this workflow was dispatched; rerun the sync.");
  await verified(main);
  const previousMirror = await branch(MIRROR);
  if (previousMirror !== sha) {
    if (previousMirror && !(await contains(previousMirror, sha, UPSTREAM))) {
      throw new Error(
        "Published upstream nightly moved backwards or diverged; review before changing the mirror.",
      );
    }
    await push({ sha, expectedSha: previousMirror, token });
    if ((await branch(MIRROR)) !== sha) throw new Error("The nightly mirror changed during sync.");
  }
  if (await contains(sha, main))
    return { changed: false, sha, reason: "main already contains this published nightly." };
  if (!(await branch(CANDIDATE))) {
    await candidateGithub.rest.git.createRef({
      ...REPOSITORY,
      ref: `refs/heads/${CANDIDATE}`,
      sha: main,
    });
  }
  let candidate = await branch(CANDIDATE);
  for (const head of [main, sha]) {
    if ((await branch(CANDIDATE)) !== candidate)
      throw new Error("The candidate changed during sync.");
    try {
      const merged = await candidateGithub.rest.repos.merge({
        ...REPOSITORY,
        base: CANDIDATE,
        head,
        commit_message: `chore(sync): merge ${head === main ? "protected main" : nightly.tag_name}`,
      });
      if (merged.status !== 204) {
        const result = merged.data;
        const exactParents =
          result.parents?.length === 2 &&
          result.parents[0].sha === candidate &&
          result.parents[1].sha === head;
        const fastForward = result.sha === head && (await contains(candidate, head));
        if (!SHA.test(result.sha) || (!exactParents && !fastForward))
          throw new Error("The merge did not use the pinned candidate and source.");
        candidate = result.sha;
      }
      if ((await branch(CANDIDATE)) !== candidate)
        throw new Error("The candidate changed after the merge.");
    } catch (error) {
      if (error.status === 409)
        throw new Error(
          `Nightly merge conflicts need resolution on ${CANDIDATE}; main was not changed.`,
          { cause: error },
        );
      throw error;
    }
  }
  await verified(candidate);
  if (!(await contains(main, candidate)) || !(await contains(sha, candidate))) {
    throw new Error("The candidate must contain both pinned main and upstream nightly.");
  }
  if ((await branch("main")) !== main || (await branch(MIRROR)) !== sha) {
    throw new Error("main or upstream/nightly changed during sync; rerun against the new pins.");
  }
  const { data: open } = await github.rest.pulls.list({
    ...REPOSITORY,
    state: "open",
    base: "main",
    head: `${REPOSITORY.owner}:${CANDIDATE}`,
  });
  const fields = {
    title: `chore(sync): update to ${nightly.tag_name}`,
    body: `Bring the published [upstream nightly](https://github.com/pingdotgg/t3code/releases/tag/${nightly.tag_name}) into the fork.\n\nUpstream source: \`${sha}\`. The mirror remains exact upstream; this candidate merges it with main \`${main}\`.\n\nCI and Agent Context Budget are dispatched explicitly on \`${candidate}\`, because changes made with GITHUB_TOKEN do not trigger them automatically. Review conflicts, workflow changes, and the normal checks before merging.\n\nCreated by the repository's nightly sync workflow.`,
  };
  const pull = open[0]
    ? (await github.rest.pulls.update({ ...REPOSITORY, pull_number: open[0].number, ...fields }))
        .data
    : (await github.rest.pulls.create({ ...REPOSITORY, base: "main", head: CANDIDATE, ...fields }))
        .data;
  if (pull.head.sha !== candidate || pull.base.sha !== main)
    throw new Error("PR source or base moved before CI dispatch.");
  for (const workflow_id of ["ci.yml", "agent-context-budget.yml"]) {
    const { data: runs } = await github.rest.actions.listWorkflowRuns({
      ...REPOSITORY,
      workflow_id,
      head_sha: candidate,
      event: "workflow_dispatch",
      per_page: 100,
    });
    if (!retry && runs.workflow_runs.some((run) => run.head_sha === candidate)) continue;
    await github.rest.actions.createWorkflowDispatch({
      ...REPOSITORY,
      workflow_id,
      ref: CANDIDATE,
      inputs: { expected_sha: candidate, base_sha: main, pull_request: String(pull.number) },
    });
  }
  const review = autoMerge
    ? await mergeReviewedNightly({
        github,
        merger: candidateGithub,
        pullNumber: pull.number,
        head: candidate,
        base: main,
      })
    : { merged: false, reason: "Automatic nightly merging is disabled." };
  return { changed: true, sha, candidate, pull: pull.html_url, review };
}

module.exports = { selectNightly, syncUpstreamNightly, pushMirror };
