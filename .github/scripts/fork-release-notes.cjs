const MAX_HIGHLIGHTS = 7;
const MAX_NIGHTLY_CANDIDATES = 100;
const isSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const isNightly = (value) =>
  typeof value === "string" && /^(?:nightly-)?v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(value);

function parseRepository(repository) {
  const parts =
    typeof repository === "string" ? repository.split("/") : [repository?.owner, repository?.repo];
  if (
    parts.length !== 2 ||
    parts.some((part) => typeof part !== "string" || !/^[\w.-]+$/.test(part))
  ) {
    throw new Error("Expected a GitHub repository in owner/repo format.");
  }
  return { owner: parts[0], repo: parts[1] };
}

function cleanHighlight(text) {
  return text
    .trim()
    .replace(/\s*\(#\d+\)\s*$/, "")
    .replace(/\s+/g, " ");
}

function commitHighlights(commit) {
  const message = commit?.commit?.message;
  if (!isSha(commit?.sha) || typeof message !== "string" || !Array.isArray(commit.parents))
    return [];
  const subject = message.split(/\r?\n/, 1)[0];
  if (commit.parents.length > 1 || /^Merge\b/i.test(subject)) return [];
  const trailers = [...message.matchAll(/^Release-Note:[ \t]*(.*)$/gim)];
  if (trailers.length > 0) {
    return trailers
      .map((match) => cleanHighlight(match[1]))
      .filter((text) => text && !/^(?:none|no|n\/a)\.?$/i.test(text));
  }
  const conventional = /^(feat|fix|perf|revert)(?:\(([^)]*)\))?!?:\s*(.+)$/i.exec(subject);
  if (!conventional) return [];
  if (
    conventional[2]
      ?.split(/[,/]/)
      .some((scope) => /^(?:ci|build|docs?|tests?|chore|deps?|dependencies)$/i.test(scope.trim()))
  )
    return [];
  if (
    /^(?:bump|upgrade|update|pin)\b.*\b(?:dep(?:endency|endencies)?|packages?|lockfiles?)\b/i.test(
      conventional[3],
    )
  )
    return [];
  const text = cleanHighlight(conventional[3]);
  return text ? [text[0].toUpperCase() + text.slice(1)] : [];
}

function upstreamHighlights(body) {
  if (typeof body !== "string") return [];
  const top = body.split(
    /<details\b|^#{1,6}\s+(?:full changelog|what'?s changed|new contributors)\b|^\*\*full changelog\b/im,
    1,
  )[0];
  const highlights = [];
  for (const line of top.split(/\r?\n/)) {
    const bullet = /^[-*]\s+(.+)/.exec(line.trim());
    if (bullet) {
      const text = cleanHighlight(bullet[1]);
      if (text && !/^full changelog\b/i.test(text)) highlights.push(text);
    } else if (/^\s{2,}\S/.test(line) && highlights.length > 0) {
      highlights[highlights.length - 1] += ` ${line.trim()}`;
    }
  }
  if (highlights.length === 0) {
    const count = /^\*\*\d+ (?:bug fixes?|performance improvements?)[^\n]*\*\*\.?$/im.exec(top);
    if (count) highlights.push(count[0]);
  }
  return highlights;
}

function uniqueHighlights(items) {
  const seen = new Set();
  return items.filter((text) => {
    const key = text.replace(/[*_`]/g, "").replace(/[.!]$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function highlightSection(title, source, items) {
  if (items.length === 0) return "";
  // Installed updaters discard headings but preserve each item's leading bold label.
  const bullets = items.map((text) =>
    text.startsWith("**")
      ? `- ${text.replace(/^\*\*/, `**${source}: `)}`
      : `- **${source}:** ${text}`,
  );
  return `## ${title}\n\n${bullets.join("\n")}`;
}

async function generateForkReleaseNotes({
  github,
  repository,
  ref,
  previousRef,
  upstreamRepository = "pingdotgg/t3code",
}) {
  const fork = parseRepository(repository);
  const upstream = parseRepository(upstreamRepository);
  const repos = github.rest.repos;
  const resolveCommit = async (repo, sourceRef) => {
    if (typeof sourceRef !== "string" || !sourceRef.trim())
      throw new Error("A release source ref is required.");
    const { data } = await repos.getCommit({ ...repo, ref: sourceRef });
    if (!isSha(data?.sha))
      throw new Error(`GitHub did not return a valid commit SHA for ${sourceRef}.`);
    return data.sha;
  };
  const currentSha = await resolveCommit(fork, ref);
  const previousSha = previousRef ? await resolveCommit(fork, previousRef) : undefined;
  let candidateCount = 0;
  const releases = await github.paginate(
    repos.listReleases,
    { ...upstream, per_page: 100 },
    (response, done) => {
      if (!Array.isArray(response.data))
        throw new Error("GitHub returned an invalid upstream release list.");
      const page = response.data
        .filter(
          (release) =>
            release &&
            release.draft === false &&
            isNightly(release.tag_name) &&
            Number.isFinite(Date.parse(release.published_at)),
        )
        .map(({ tag_name, published_at, body }) => ({ tag_name, published_at, body }));
      candidateCount += page.length;
      if (candidateCount >= MAX_NIGHTLY_CANDIDATES) done();
      return page;
    },
  );
  const nightlies = releases
    .sort(
      (a, b) =>
        Date.parse(b.published_at) - Date.parse(a.published_at) ||
        (a.tag_name < b.tag_name ? 1 : a.tag_name > b.tag_name ? -1 : 0),
    )
    .slice(0, MAX_NIGHTLY_CANDIDATES);
  const ancestry = new Map();
  const contains = (base, head) => {
    const basehead = `${base}...${head}`;
    if (!ancestry.has(basehead)) {
      ancestry.set(
        basehead,
        repos
          .compareCommitsWithBasehead({ ...fork, basehead, per_page: 1 })
          .then(({ data }) => {
            if (!["ahead", "identical", "behind", "diverged"].includes(data?.status))
              throw new Error(`GitHub returned an invalid ancestry comparison for ${basehead}.`);
            return data.status === "ahead" || data.status === "identical";
          })
          .catch((error) => {
            if (error.status === 404) return false;
            throw error;
          }),
      );
    }
    return ancestry.get(basehead);
  };
  let newestIncluded;
  let foundBaseline = !previousSha;
  const incorporated = [];
  for (const nightly of nightlies) {
    const sha = await resolveCommit(upstream, nightly.tag_name);
    if (!(await contains(sha, currentSha))) continue;
    newestIncluded ??= { ...nightly, sha };
    if (!previousSha) {
      incorporated.push(nightly);
      break;
    }
    if (await contains(sha, previousSha)) {
      foundBaseline = true;
      break;
    }
    incorporated.push(nightly);
  }
  if ((!newestIncluded || !foundBaseline) && candidateCount >= MAX_NIGHTLY_CANDIDATES)
    throw new Error(
      `Could not find an upstream nightly baseline within ${MAX_NIGHTLY_CANDIDATES} candidates.`,
    );
  if (previousSha && !foundBaseline)
    throw new Error(
      "Could not find a published upstream nightly contained in the previous fork release.",
    );

  const readRange = async (base) => {
    const commits = await github.paginate(
      repos.compareCommitsWithBasehead,
      { ...fork, basehead: `${base}...${currentSha}`, per_page: 100 },
      (response) => {
        const page = Array.isArray(response.data) ? response.data : response.data?.commits;
        if (!Array.isArray(page))
          throw new Error("GitHub returned an invalid commit comparison page.");
        return page;
      },
    );
    return commits.filter((commit) => isSha(commit?.sha));
  };
  let forkHighlights = [];
  if (newestIncluded) {
    const forkCommits = await readRange(newestIncluded.sha);
    const newShas = previousSha
      ? new Set((await readRange(previousSha)).map((commit) => commit.sha))
      : undefined;
    forkHighlights = uniqueHighlights(
      forkCommits
        .filter((commit) => !newShas || newShas.has(commit.sha))
        .reverse()
        .flatMap(commitHighlights),
    );
  }
  const upstreamNotes = uniqueHighlights(
    incorporated.flatMap((release) => upstreamHighlights(release.body)),
  );
  const forkLimit = upstreamNotes.length > 0 ? MAX_HIGHLIGHTS - 1 : MAX_HIGHLIGHTS;
  const forkItems = forkHighlights.slice(0, forkLimit);
  const upstreamItems = uniqueHighlights([...forkItems, ...upstreamNotes]).slice(
    forkItems.length,
    MAX_HIGHLIGHTS,
  );
  const sections = [
    highlightSection("Our changes", "Our fork", forkItems),
    highlightSection("Upstream changes", "Upstream", upstreamItems),
  ].filter(Boolean);
  const introduction = previousSha ? "" : "First fork release.\n\n";
  const summary =
    sections.length > 0
      ? sections.join("\n\n")
      : previousSha
        ? "No user-facing changes were identified since the previous fork release."
        : "No user-facing highlights were identified for this build.";
  const forkUrl = `https://github.com/${fork.owner}/${fork.repo}`;
  const upstreamUrl = `https://github.com/${upstream.owner}/${upstream.repo}`;
  const links = [`[Source](${forkUrl}/tree/${currentSha})`];
  if (previousSha)
    links.push(
      `[Full comparison with the previous fork release](${forkUrl}/compare/${previousSha}...${currentSha})`,
    );
  if (newestIncluded) {
    links.push(
      `[Included upstream nightly ${newestIncluded.tag_name}](${upstreamUrl}/releases/tag/${encodeURIComponent(newestIncluded.tag_name)})`,
    );
    links.push(
      `[Fork changes since the included upstream nightly](${forkUrl}/compare/${newestIncluded.sha}...${currentSha})`,
    );
  }
  for (const nightly of incorporated) {
    if (nightly.tag_name !== newestIncluded?.tag_name)
      links.push(
        `[Upstream nightly ${nightly.tag_name}](${upstreamUrl}/releases/tag/${encodeURIComponent(nightly.tag_name)})`,
      );
  }
  return `${introduction}${summary}\n\n<details>\n<summary>Full changelog</summary>\n\n${links.join("\n\n")}\n\n</details>\n`;
}

module.exports = { generateForkReleaseNotes };
