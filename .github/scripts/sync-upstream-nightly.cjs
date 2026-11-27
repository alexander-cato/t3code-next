const { mergeReviewedNightly, requiredChecks } = require("./fork-sync-review.cjs");
const { CATALOG, mergeCatalog } = require("./catalog-merge.cjs");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const REPOSITORY = { owner: "alexander-cato", repo: "t3code-next" };
const UPSTREAM = { owner: "pingdotgg", repo: "t3code" };
const MIRROR = "upstream/nightly";
const CANDIDATE = "sync/upstream-nightly";
const SHA = /^[a-f0-9]{40}$/;
const ISSUE_AUTHOR = "github-actions[bot]";
const ISSUE_STATE = /<!-- nightly-sync-blocked (\{[^\n]*?\}) -->/;

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

function listConflicts({ base, ours, theirs }) {
  const git = (...args) =>
    execFileSync("git", ["-c", "credential.helper=", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  git("fetch", "--no-tags", "--depth=1", "--filter=blob:none", "origin", base, ours, theirs);
  try {
    git(
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      `--merge-base=${base}`,
      ours,
      theirs,
    );
    return [];
  } catch (error) {
    // Exit 1 prints the merged tree, then one conflicted path per line.
    if (error.status !== 1) throw error;
    return [...new Set(error.stdout.split("\n").slice(1).filter(Boolean))];
  }
}

// Builds the merge locally when every conflict is a translation catalog. GitHub's merge API takes no
// resolution, so the result goes back through the Git Data API, which signs the commit.
function resolveCatalogConflicts({ base, ours, theirs }) {
  const directory = mkdtempSync(join(tmpdir(), "t3-nightly-catalogs-"));
  try {
    const git = (args, { input, raw = false } = {}) => {
      const output = execFileSync("git", ["-c", "credential.helper=", ...args], {
        encoding: raw ? "buffer" : "utf8",
        input,
        maxBuffer: 1 << 28,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_INDEX_FILE: join(directory, "index") },
      });
      return raw ? output : output.replace(/\n$/, "");
    };
    let merged;
    try {
      git([
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        `--merge-base=${base}`,
        ours,
        theirs,
      ]);
      return undefined;
    } catch (error) {
      if (error.status !== 1) throw error;
      merged = error.stdout.split("\n").filter(Boolean);
    }
    const [conflictTree, ...conflicts] = [...new Set(merged)];
    if (!conflicts.length || !conflicts.every((file) => CATALOG.test(file))) return undefined;
    git(["read-tree", conflictTree]);
    for (const path of conflicts) {
      const text = mergeCatalog(
        ...[base, ours, theirs].map((rev) =>
          git(["cat-file", "blob", `${rev}:${path}`], { raw: true }).toString("utf8"),
        ),
      );
      if (text === undefined) return undefined;
      const blob = git(["hash-object", "-w", "--stdin"], { input: text });
      git(["update-index", "--cacheinfo", `100644,${blob},${path}`]);
    }
    const tree = git(["write-tree"]);
    const upstream = new Map(
      git(["ls-tree", "-r", "-z", "--full-tree", theirs])
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const [meta, path] = line.split("\t");
          return [path, meta.split(" ")[2]];
        }),
    );
    const records = git(["diff-tree", "-r", "-z", "--no-renames", ours, tree])
      .split("\0")
      .filter(Boolean);
    const entries = [];
    for (let i = 0; i < records.length; i += 2) {
      const [oldMode, newMode, , sha, status] = records[i].slice(1).split(" ");
      const path = records[i + 1];
      const mode = status === "D" ? oldMode : newMode;
      const type = mode === "160000" ? "commit" : "blob";
      const entry = { path, mode, type, sha: status === "D" ? null : sha };
      // GitHub already has every blob of the upstream nightly; text merges and catalogs are new.
      if (entry.sha && type === "blob" && upstream.get(path) !== sha)
        entry.content = git(["cat-file", "blob", sha], { raw: true }).toString("base64");
      entries.push(entry);
    }
    return { baseTree: git(["rev-parse", `${ours}^{tree}`]), tree, entries, files: conflicts };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function commitResolution({ github, resolution, parents, message }) {
  // Octokit reports a dropped connection only as "fetch failed", so name the request that failed.
  const step = (label, request) =>
    request.catch((error) => {
      throw new Error(`${label}: ${error.message}`, { cause: error });
    });
  for (const entry of resolution.entries.filter((item) => item.content !== undefined)) {
    const { data } = await step(
      `Uploading ${entry.path}`,
      github.rest.git.createBlob({ ...REPOSITORY, content: entry.content, encoding: "base64" }),
    );
    if (data.sha !== entry.sha) throw new Error(`GitHub stored ${entry.path} as a different blob.`);
  }
  // GitHub answers one create-tree request for a whole nightly with a 502, so each batch builds on the last.
  const tree = { sha: resolution.baseTree };
  for (let i = 0; i < resolution.entries.length; i += 100) {
    const { data } = await step(
      `Building tree entries ${i + 1}-${Math.min(i + 100, resolution.entries.length)}`,
      github.rest.git.createTree({
        ...REPOSITORY,
        base_tree: tree.sha,
        tree: resolution.entries
          .slice(i, i + 100)
          .map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
      }),
    );
    tree.sha = data.sha;
  }
  if (tree.sha !== resolution.tree)
    throw new Error("GitHub built a different tree than the local merge.");
  const { data: commit } = await step(
    "Creating the merge commit",
    github.rest.git.createCommit({ ...REPOSITORY, message, tree: tree.sha, parents }),
  );
  if (!SHA.test(commit.sha)) throw new Error("GitHub returned an invalid merge commit.");
  await step(
    `Moving ${CANDIDATE}`,
    github.rest.git.updateRef({
      ...REPOSITORY,
      ref: `heads/${CANDIDATE}`,
      sha: commit.sha,
      force: false,
    }),
  );
  return commit.sha;
}

function blockedIssue(state) {
  const { tag, nightly, main, candidate, head, conflicts, pull, reason } = state;
  const resolve = conflicts
    ? [
        "### Conflicting files",
        "",
        ...(conflicts.length
          ? conflicts.map((file) => `- \`${file}\``)
          : ["- Unknown; merge locally to see them."]),
        "",
        "### Resolve",
        "",
        "```sh",
        "git fetch --no-tags origin main sync/upstream-nightly upstream/nightly",
        "git switch --detach origin/sync/upstream-nightly",
        `git merge --no-ff ${head === main ? "origin/main" : "origin/upstream/nightly"} -m "chore(sync): merge ${tag}"`,
        "node .github/scripts/catalog-merge.cjs # merges conflicted translation catalogs key by key",
        "# if pnpm-lock.yaml changed on both sides: git checkout origin/upstream/nightly -- pnpm-lock.yaml && vp i",
        "# resolve, check, and commit with a signature GitHub verifies",
        "git push origin HEAD:sync/upstream-nightly",
        "```",
        "",
        "The next sync run uses the pushed resolution, opens the nightly PR, and closes this issue.",
      ]
    : [
        `Fix a failed check on ${pull} through \`sync/upstream-nightly\` or \`main\`. Fix each review`,
        "finding on a fork change or reply with why it stays, then resolve its thread. The sync merges once unblocked and",
        "closes this issue; run the sync with `retry` to re-dispatch unchanged checks.",
      ];
  return {
    title: `Nightly sync blocked: ${tag}`,
    body: [
      `${reason} The fork stays on its current nightly until this is fixed.`,
      "",
      `- Upstream nightly: [${tag}](https://github.com/pingdotgg/t3code/releases/tag/${tag}) \`${nightly}\``,
      `- main: \`${main}\``,
      `- Candidate \`sync/upstream-nightly\`: \`${candidate}\``,
      "",
      ...resolve,
      "",
      `<!-- nightly-sync-blocked ${JSON.stringify({ kind: conflicts ? "conflict" : "check", nightly, main, candidate })} -->`,
    ].join("\n"),
  };
}

async function syncUpstreamNightly({
  github,
  candidateGithub = github,
  context,
  retry = false,
  autoMerge = false,
  token,
  push = pushMirror,
  conflictsOf = listConflicts,
  resolveConflicts = resolveCatalogConflicts,
  review = mergeReviewedNightly,
  checks = requiredChecks,
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
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...REPOSITORY,
    state: "open",
    per_page: 100,
  });
  const blocked = issues
    .filter((issue) => !issue.pull_request && issue.user?.login === ISSUE_AUTHOR)
    .map((issue) => {
      try {
        return { issue, state: JSON.parse(issue.body?.match(ISSUE_STATE)?.[1]) };
      } catch {
        return undefined;
      }
    })
    .find(Boolean);
  const unblock = async (comment) => {
    if (!blocked) return;
    await github.rest.issues.createComment({
      ...REPOSITORY,
      issue_number: blocked.issue.number,
      body: comment,
    });
    await github.rest.issues.update({
      ...REPOSITORY,
      issue_number: blocked.issue.number,
      state: "closed",
    });
  };
  const block = async (state) => {
    const fields = blockedIssue({ ...state, tag: nightly.tag_name, nightly: sha, main });
    if (blocked) {
      if (blocked.issue.body !== fields.body || blocked.issue.title !== fields.title)
        await github.rest.issues.update({
          ...REPOSITORY,
          issue_number: blocked.issue.number,
          ...fields,
        });
      return blocked.issue.html_url;
    }
    const { data } = await github.rest.issues.create({
      ...REPOSITORY,
      ...fields,
      assignees: [REPOSITORY.owner],
    });
    return data.html_url;
  };
  if (await contains(sha, main)) {
    await unblock(`main contains ${nightly.tag_name}.`);
    return { changed: false, sha, reason: "main already contains this published nightly." };
  }
  if (!(await branch(CANDIDATE))) {
    await candidateGithub.rest.git.createRef({
      ...REPOSITORY,
      ref: `refs/heads/${CANDIDATE}`,
      sha: main,
    });
  }
  let candidate = await branch(CANDIDATE);
  const known = blocked?.state;
  if (
    !retry &&
    known?.kind === "conflict" &&
    known.nightly === sha &&
    known.main === main &&
    known.candidate === candidate
  )
    return {
      changed: false,
      sha,
      reason: `Waiting for the conflict resolution in ${blocked.issue.html_url}.`,
    };
  for (const head of [main, sha]) {
    if ((await branch(CANDIDATE)) !== candidate)
      throw new Error("The candidate changed during sync.");
    const message = `chore(sync): merge ${head === main ? "protected main" : nightly.tag_name}`;
    let merged;
    try {
      merged = await candidateGithub.rest.repos.merge({
        ...REPOSITORY,
        base: CANDIDATE,
        head,
        commit_message: message,
      });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
    if (merged) {
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
      continue;
    }
    let conflicts = [];
    let resolved;
    try {
      const { data } = await github.rest.repos.compareCommitsWithBasehead({
        ...REPOSITORY,
        basehead: `${candidate}...${head}`,
      });
      const pins = { base: data.merge_base_commit.sha, ours: candidate, theirs: head };
      conflicts = conflictsOf(pins);
      const resolution =
        conflicts.length && conflicts.every((file) => CATALOG.test(file))
          ? resolveConflicts(pins)
          : undefined;
      if (resolution)
        resolved = await commitResolution({
          github: candidateGithub,
          resolution,
          parents: [candidate, head],
          message: `${message}\n\nMerged translation catalogs key by key:\n${resolution.files.map((file) => `- ${file}`).join("\n")}`,
        });
    } catch (resolving) {
      console.warn(`Could not resolve the conflicting files: ${resolving.message}`);
    }
    if (resolved) {
      if ((await branch(CANDIDATE)) !== resolved)
        throw new Error("The candidate changed after the catalog merge.");
      candidate = resolved;
      continue;
    }
    const reason = `Merging ${head === main ? "main" : nightly.tag_name} into ${CANDIDATE} conflicts.`;
    const issue = await block({ reason, head, candidate, conflicts });
    return { changed: false, sha, reason: `${reason} Resolution needed: ${issue}` };
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
    body: `Bring the published [upstream nightly](https://github.com/pingdotgg/t3code/releases/tag/${nightly.tag_name}) into the fork.\n\nUpstream source: \`${sha}\`. The mirror remains exact upstream; this candidate merges it with main \`${main}\`.\n\nCI, Agent Context Budget, and Security are dispatched explicitly on \`${candidate}\`, because changes made with GITHUB_TOKEN do not trigger them automatically. Review conflicts, workflow changes, and the normal checks before merging.\n\nCreated by the repository's nightly sync workflow.`,
  };
  const pull = open[0]
    ? (await github.rest.pulls.update({ ...REPOSITORY, pull_number: open[0].number, ...fields }))
        .data
    : (await github.rest.pulls.create({ ...REPOSITORY, base: "main", head: CANDIDATE, ...fields }))
        .data;
  if (pull.head.sha !== candidate || pull.base.sha !== main)
    throw new Error("PR source or base moved before CI dispatch.");
  for (const workflow_id of ["ci.yml", "agent-context-budget.yml", "security.yml"]) {
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
  const result = autoMerge
    ? await review({
        github,
        merger: candidateGithub,
        pullNumber: pull.number,
        head: candidate,
        base: main,
        upstream: sha,
      })
    : await checks({ github, head: candidate }).then((status) =>
        status?.blocked
          ? { merged: false, ...status }
          : {
              merged: false,
              waiting: status?.waiting,
              reason: "Automatic nightly merging is disabled.",
            },
      );
  if (result.blocked) {
    const issue = await block({ reason: result.reason, candidate, pull: pull.html_url });
    return {
      changed: true,
      sha,
      candidate,
      pull: pull.html_url,
      review: { ...result, reason: `${result.reason} Fix needed: ${issue}` },
    };
  }
  // A failed check stays reported until its replacement passes, not while it reruns.
  if (blocked?.state.kind !== "check" || !result.waiting)
    await unblock(`${nightly.tag_name} is no longer blocked in ${pull.html_url}.`);
  return { changed: true, sha, candidate, pull: pull.html_url, review: result };
}

module.exports = {
  selectNightly,
  syncUpstreamNightly,
  pushMirror,
  listConflicts,
  resolveCatalogConflicts,
};
