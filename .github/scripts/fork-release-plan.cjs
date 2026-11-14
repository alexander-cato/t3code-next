const SHA = /^[a-f0-9]{40}$/;
const NIGHTLY = /^v?(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/;

function parseNightly(value) {
  const match = NIGHTLY.exec(value);
  return match ? match.slice(1).map(BigInt) : undefined;
}

function compareVersion(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function nextVersion(packageVersion, releases, now = new Date()) {
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion))
    throw new Error("Expected a stable package version.");
  let core = packageVersion.split(".").map(BigInt);
  core[2] += 1n;
  const nightlies = releases.map((release) => parseNightly(release.tag_name)).filter(Boolean);
  for (const release of releases) {
    const stable = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(release.tag_name);
    if (stable) {
      const publishedCore = stable.slice(1).map(BigInt);
      if (compareVersion(publishedCore, core) >= 0) {
        core = publishedCore;
        core[2] += 1n;
      }
    }
  }
  for (const version of nightlies) {
    if (compareVersion(version.slice(0, 3), core) > 0) core = version.slice(0, 3);
  }
  let date = BigInt(now.toISOString().slice(0, 10).replaceAll("-", ""));
  const sameCore = nightlies.filter((version) => compareVersion(version.slice(0, 3), core) === 0);
  for (const version of sameCore) if (version[3] > date) date = version[3];
  let sequence = 0n;
  for (const version of sameCore) {
    if (version[3] === date && version[4] > sequence) sequence = version[4];
  }
  return `${core.join(".")}-nightly.${date}.${sequence + 1n}`;
}

async function resolveRelease({ github, context, force = false, now = new Date() }) {
  const repository = context.repo;
  if (
    `${repository.owner}/${repository.repo}` !== "alexander-cato/t3code-next" ||
    context.ref !== "refs/heads/main"
  ) {
    throw new Error("Fork releases only run from the successor's protected main branch.");
  }
  const run = context.payload.workflow_run;
  if (
    context.eventName !== "workflow_dispatch" &&
    !(
      context.eventName === "workflow_run" &&
      run?.event === "push" &&
      run?.head_branch === "main" &&
      run?.conclusion === "success" &&
      run?.head_repository?.full_name === "alexander-cato/t3code-next"
    )
  ) {
    throw new Error("Expected a manual main dispatch or successful main CI push.");
  }
  const ref = run?.head_sha ?? context.sha;
  if (!SHA.test(ref)) throw new Error("Invalid release source SHA.");
  const { data: main } = await github.rest.repos.getBranch({ ...repository, branch: "main" });
  if (!main.protected) throw new Error("main must remain protected before releasing.");
  if (main.commit.sha !== ref)
    return { build: false, reason: "A newer main commit supersedes this run." };
  const { data: source } = await github.rest.repos.getCommit({ ...repository, ref });
  if (source.sha !== ref || source.commit?.verification?.verified !== true) {
    throw new Error("The pinned source must be a GitHub-verified commit on protected main.");
  }
  const { data: checks } = await github.rest.actions.listWorkflowRuns({
    ...repository,
    workflow_id: "ci.yml",
    head_sha: ref,
    branch: "main",
    event: "push",
    per_page: 100,
  });
  const latest = checks.workflow_runs
    .filter(
      (check) =>
        check.head_sha === ref && check.head_repository?.full_name === "alexander-cato/t3code-next",
    )
    .sort((a, b) => b.id - a.id)[0];
  if (latest?.status !== "completed" || latest.conclusion !== "success") {
    throw new Error("The latest CI push run for this exact main SHA must succeed before release.");
  }
  const current = await github.paginate(github.rest.repos.listReleases, {
    ...repository,
    per_page: 100,
  });
  const legacy = await github.paginate(github.rest.repos.listReleases, {
    owner: "alexander-cato",
    repo: "t3code",
    per_page: 100,
  });
  const previous = current
    .filter((release) => !release.draft && release.published_at && parseNightly(release.tag_name))
    .sort((a, b) => compareVersion(parseNightly(b.tag_name), parseNightly(a.tag_name)))[0];
  let previousRef;
  if (previous) {
    const { data: previousSource } = await github.rest.repos.getCommit({
      ...repository,
      ref: previous.tag_name,
    });
    previousRef = previousSource.sha;
    if (!SHA.test(previousRef)) throw new Error("Invalid previous release source SHA.");
    if (previousRef === ref && !force)
      return { build: false, reason: "This source already has a release." };
    const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
      ...repository,
      basehead: `${previousRef}...${ref}`,
    });
    if (!["ahead", "identical"].includes(comparison.status))
      throw new Error(
        "Refusing to release source older than or divergent from the previous release.",
      );
  }
  const { data: manifest } = await github.rest.repos.getContent({
    ...repository,
    path: "apps/desktop/package.json",
    ref,
  });
  if (manifest.type !== "file" || manifest.encoding !== "base64")
    throw new Error("Invalid desktop package manifest.");
  const version = nextVersion(
    JSON.parse(Buffer.from(manifest.content, "base64").toString("utf8")).version,
    [...current, ...legacy, { tag_name: "v0.1.10-nightly.20261112.346" }],
    now,
  );
  return { build: true, ref, previousRef, version, tag: `v${version}` };
}

module.exports = { nextVersion, resolveRelease };
