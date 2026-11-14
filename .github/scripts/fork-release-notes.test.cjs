const assert = require("node:assert/strict");
const test = require("node:test");
const { generateForkReleaseNotes } = require("./fork-release-notes.cjs");

const sha = (number) => number.toString(16).padStart(40, "0");
const current = sha(1);
const previous = sha(2);
const upstream = sha(3);
const olderUpstream = sha(4);
const futureUpstream = sha(5);
const tag = (number) => `v0.1.8-nightly.20261111.${number}`;
const release = (number, body, overrides = {}) => ({
  tag_name: tag(number),
  draft: false,
  published_at: `2026-11-11T${String(number).padStart(2, "0")}:00:00Z`,
  body,
  ...overrides,
});
const commit = (number, message, parents = [{}]) => ({
  sha: sha(number),
  commit: { message },
  parents,
});

function fixture({
  releases = [
    [
      release(2, "- **Upstream improvement.** Restore remote connections."),
      release(1, "- Old highlight."),
    ],
  ],
  relations = {},
  ranges = {},
  additionalRefs = {},
  previousRef = "previous",
} = {}) {
  const calls = [];
  const refs = {
    current,
    previous,
    [tag(1)]: olderUpstream,
    [tag(2)]: upstream,
    [tag(3)]: futureUpstream,
    ...additionalRefs,
  };
  const comparisons = {
    [`${upstream}...${current}`]: "ahead",
    [`${upstream}...${previous}`]: "behind",
    [`${olderUpstream}...${current}`]: "ahead",
    [`${olderUpstream}...${previous}`]: "ahead",
    [`${futureUpstream}...${current}`]: "behind",
    ...relations,
  };
  const repos = {
    async listReleases({ page = 1 }) {
      calls.push({ method: "listReleases", page });
      return { data: releases[page - 1] };
    },
    async getCommit(params) {
      calls.push({ method: "getCommit", ...params });
      return { data: { sha: refs[params.ref] } };
    },
    async compareCommitsWithBasehead(params) {
      calls.push({ method: "compare", ...params });
      return {
        data: {
          status: comparisons[params.basehead] ?? "ahead",
          commits: ranges[params.basehead]?.[(params.page ?? 1) - 1] ?? [],
        },
      };
    },
  };
  return {
    calls,
    options: {
      repository: "example/fork",
      ref: "current",
      previousRef,
      github: {
        rest: { repos },
        async paginate(method, params, map = (response) => response.data) {
          calls.push({ method: "paginate", ...params });
          const pages =
            method === repos.listReleases ? releases : (ranges[params.basehead] ?? [[]]);
          const result = [];
          let done = false;
          for (let index = 0; index < pages.length; index++) {
            result.push(
              ...map(await method({ ...params, page: index + 1 }), () => {
                done = true;
              }),
            );
            if (done) break;
          }
          return result;
        },
      },
    },
  };
}

const summary = (notes) => notes.split("<details>")[0];

test("uses only newly incorporated upstream nightlies and new fork-only commits", async () => {
  const forkCommit = commit(10, "feat(desktop): remember the selected provider (#42)");
  const upstreamCommit = commit(11, "feat: an upstream commit outside its nightly");
  const { options } = fixture({
    releases: [
      [release(3, "- Future highlight that has not shipped in this fork.")],
      [
        release(1, "- Old highlight."),
        release(
          2,
          "- **Upstream improvement.** Restore remote connections.\n\n<details><summary>Full changelog</summary>\n- Raw upstream commit.\n</details>",
        ),
      ],
    ],
    ranges: {
      [`${previous}...${current}`]: [[upstreamCommit, forkCommit]],
      [`${upstream}...${current}`]: [[forkCommit]],
    },
  });
  const notes = await generateForkReleaseNotes(options);
  assert.equal(
    summary(notes).trim(),
    "## Our changes\n\n- **Our fork:** Remember the selected provider\n\n## Upstream changes\n\n- **Upstream: Upstream improvement.** Restore remote connections.",
  );
  assert.doesNotMatch(
    notes,
    /Future highlight|Raw upstream commit|Old highlight|an upstream commit/,
  );
  assert.match(
    notes,
    new RegExp(`https://github.com/example/fork/compare/${previous}\\.\\.\\.${current}`),
  );
  assert.match(notes, /<details>\s*<summary>Full changelog<\/summary>/);
  assert.doesNotMatch(summary(notes), /Source|https:\/\/github.com/);
});

test("does not repeat upstream highlights on a fork-only rebuild", async () => {
  const forkCommit = commit(10, "fix(web): retain the selected environment");
  const { options } = fixture({
    relations: { [`${upstream}...${previous}`]: "ahead" },
    ranges: {
      [`${previous}...${current}`]: [[forkCommit]],
      [`${upstream}...${current}`]: [[forkCommit]],
    },
  });
  const notes = await generateForkReleaseNotes(options);
  assert.equal(
    summary(notes).trim(),
    "## Our changes\n\n- **Our fork:** Retain the selected environment",
  );
  assert.match(notes, new RegExp(`/releases/tag/${tag(2)}`));
});

test("omits merge and maintenance noise while preferring explicit release notes", async () => {
  const commits = [
    commit(10, "feat(web): restore thread search (#12)"),
    commit(11, "fix(ci): repair the build"),
    commit(12, "fix(deps): bump packages"),
    commit(13, "docs: update instructions"),
    commit(14, "chore: run checks"),
    commit(15, "test: cover provider selection"),
    commit(16, "Merge upstream\n\nRelease-Note: Incorrect merge highlight.", [{}, {}]),
    commit(17, "feat(build): change the release workflow"),
    commit(18, "fix: update dependencies"),
    commit(
      19,
      "refactor: internal implementation\n\nRelease-Note: Keep remote sessions connected after sleep.",
    ),
    commit(20, "fix: internal repair\n\nRelease-Note: none"),
  ];
  const { options } = fixture({
    relations: { [`${upstream}...${previous}`]: "ahead" },
    ranges: { [`${previous}...${current}`]: [commits], [`${upstream}...${current}`]: [commits] },
  });
  const notes = summary(await generateForkReleaseNotes(options));
  assert.match(notes, /Restore thread search/);
  assert.match(notes, /Keep remote sessions connected after sleep/);
  assert.equal((notes.match(/^- /gm) ?? []).length, 2);
});

test("paginates both commit ranges before intersecting their SHAs", async () => {
  const noise = Array.from({ length: 100 }, (_, index) => commit(index + 100, "chore: internal"));
  const olderForkCommit = commit(300, "feat: already present before this release");
  const forkCommit = commit(301, "perf: load long threads faster");
  const { options, calls } = fixture({
    relations: { [`${upstream}...${previous}`]: "ahead" },
    ranges: {
      [`${previous}...${current}`]: [noise, [forkCommit]],
      [`${upstream}...${current}`]: [[olderForkCommit, ...noise], [forkCommit]],
    },
  });
  assert.equal(
    summary(await generateForkReleaseNotes(options)).trim(),
    "## Our changes\n\n- **Our fork:** Load long threads faster",
  );
  for (const basehead of [`${previous}...${current}`, `${upstream}...${current}`]) {
    assert.ok(
      calls.some(
        (call) => call.method === "compare" && call.basehead === basehead && call.page === 2,
      ),
    );
  }
});

test("describes a first release using only the newest included upstream baseline", async () => {
  for (const countSummary of ["**3 performance improvements.**", "**3 bug fixes.**"]) {
    const { options } = fixture({
      releases: [[release(2, countSummary), release(1, "- Old highlight.")]],
    });
    delete options.previousRef;
    const notes = await generateForkReleaseNotes(options);
    assert.match(summary(notes), /First fork release\./);
    assert.ok(summary(notes).includes(countSummary.slice(2)));
    assert.match(summary(notes), /## Upstream changes\n\n- \*\*Upstream:/);
    assert.doesNotMatch(summary(notes), /## Our changes|Our fork:/);
    assert.doesNotMatch(notes, /Old highlight|compare\/0000000000000000000000000000000000000002/);
  }
});

test("reports a rebuild honestly when no user-facing changes are found", async () => {
  const { options } = fixture({ relations: { [`${upstream}...${previous}`]: "ahead" } });
  assert.match(
    summary(await generateForkReleaseNotes(options)),
    /No user-facing changes were identified since the previous fork release\./,
  );
});

test("deduplicates and bounds highlights while leaving room for a new upstream highlight", async () => {
  const commits = Array.from({ length: 10 }, (_, index) =>
    commit(10 + index, `fix: repair action ${index}`),
  );
  commits.push(commit(30, "fix(web): repair action 9 (#55)"));
  const { options } = fixture({
    ranges: { [`${previous}...${current}`]: [commits], [`${upstream}...${current}`]: [commits] },
  });
  const notes = summary(await generateForkReleaseNotes(options));
  assert.equal((notes.match(/^- /gm) ?? []).length, 7);
  assert.equal((notes.match(/Repair action 9/g) ?? []).length, 1);
  assert.match(notes, /Upstream improvement/);
  assert.equal((notes.match(/^- \*\*Our fork:/gm) ?? []).length, 6);
  assert.equal((notes.match(/^- \*\*Upstream:/gm) ?? []).length, 1);
});

test("ignores invalid release entries and rejects incomplete API responses", async () => {
  const { options } = fixture({
    releases: [
      [
        null,
        {},
        release(3, "- Draft.", { draft: true }),
        release(2, "- Valid."),
        release(1, "- Old highlight."),
      ],
    ],
  });
  assert.match(summary(await generateForkReleaseNotes(options)), /Valid/);
  options.github.rest.repos.getCommit = async () => ({ data: {} });
  await assert.rejects(generateForkReleaseNotes(options), /commit SHA/);
});

test("stops walking historical nightlies once the previous release baseline is found", async () => {
  const { options, calls } = fixture({
    releases: [
      [
        release(2, "- New highlight."),
        release(1, "- Old highlight."),
        release(0, "- Ancient highlight."),
      ],
    ],
  });
  await generateForkReleaseNotes(options);
  assert.ok(!calls.some((call) => call.method === "getCommit" && call.ref === tag(0)));
});

test("fails clearly rather than claiming highlights when the previous baseline is unavailable", async () => {
  const { options } = fixture({ releases: [[release(2, "- New highlight.")]] });
  await assert.rejects(
    generateForkReleaseNotes(options),
    /Could not find a published upstream nightly contained in the previous fork release/,
  );
});

test("stops release pagination after 100 valid published nightly candidates", async () => {
  const candidates = Array.from({ length: 100 }, (_, index) =>
    release(2, "- New highlight.", { tag_name: tag(index + 10) }),
  );
  const { options, calls } = fixture({
    releases: [
      [
        ...candidates.slice(0, 97),
        null,
        release(3, "- Draft.", { draft: true }),
        release(2, "- Stable.", { tag_name: "v0.1.8" }),
      ],
      candidates.slice(97),
      [release(1, "- Previous baseline.")],
    ],
    additionalRefs: Object.fromEntries(candidates.map((release) => [release.tag_name, upstream])),
  });
  await assert.rejects(generateForkReleaseNotes(options), /baseline within 100 candidates/);
  assert.deepEqual(
    calls.filter((call) => call.method === "listReleases").map((call) => call.page),
    [1, 2],
  );
});
