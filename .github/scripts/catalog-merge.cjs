#!/usr/bin/env node
// Merges GT translation catalogs key by key. `gt generate` appends new keys at the end, so the fork
// and upstream both edit the last line and git reports a conflict even when no key changed twice.
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const CATALOG = /^apps\/[^/]+\/src\/i18n\/translations\/[^/]+\.json$/;

// Keeps each entry's text as written, because the sync job has no oxfmt to reformat the result.
function splitCatalog(text) {
  const entries = new Map();
  let i = 0;
  const space = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) throw new Error("Unterminated string.");
    return text.slice(start, ++i);
  };
  space();
  if (text[i++] !== "{") throw new Error("A catalog must be one JSON object.");
  for (;;) {
    space();
    if (text[i] === "}") break;
    if (text[i] !== '"') throw new Error("Expected a catalog key.");
    const start = i;
    const key = JSON.parse(string());
    let depth = 0;
    while (i < text.length) {
      const char = text[i];
      if (char === '"') {
        string();
        continue;
      }
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        if (depth === 0) break;
        depth--;
      } else if (char === "," && depth === 0) break;
      i++;
    }
    const raw = text.slice(start, i).trimEnd();
    if (entries.has(key)) throw new Error(`Duplicate catalog key ${key}.`);
    entries.set(key, { raw, value: JSON.stringify(JSON.parse(`{${raw}}`)[key]) });
    if (text[i] === ",") i++;
  }
  if (joinCatalog([...entries.values()].map((entry) => entry.raw)) !== text)
    throw new Error("The catalog is not in the layout this merge can preserve.");
  return entries;
}

function joinCatalog(raws) {
  return raws.length ? `{\n  ${raws.join(",\n  ")}\n}\n` : "{}\n";
}

// Returns the merged text, or undefined when a key changed differently on both sides.
function mergeCatalog(base, ours, theirs) {
  let sides;
  try {
    sides = [base, ours, theirs].map(splitCatalog);
  } catch {
    return undefined;
  }
  const [b, o, t] = sides;
  const merged = [];
  for (const key of new Set([...t.keys(), ...o.keys()])) {
    const [bv, ov, tv] = [b, o, t].map((side) => side.get(key)?.value);
    let pick;
    if (ov === tv || ov === bv) pick = t;
    else if (tv === bv) pick = o;
    else return undefined;
    const entry = pick.get(key);
    if (entry) merged.push(entry.raw);
  }
  return joinCatalog(merged);
}

// Run during a manual merge: resolves every conflicted catalog in the working tree.
function resolveWorkingTree() {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  const conflicted = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  const left = [];
  for (const path of conflicted.filter((file) => CATALOG.test(file))) {
    let text;
    try {
      text = mergeCatalog(...[1, 2, 3].map((stage) => git("show", `:${stage}:${path}`)));
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      left.push(path);
      continue;
    }
    writeFileSync(path, text);
    git("add", "--", path);
    console.log(`merged ${path}`);
  }
  for (const path of left) console.log(`needs a manual merge: ${path}`);
  process.exitCode = left.length ? 1 : 0;
}

if (require.main === module) resolveWorkingTree();

module.exports = { CATALOG, mergeCatalog, splitCatalog };
