const assert = require("node:assert/strict");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { verifyArtifacts } = require("./verify-fork-artifacts.cjs");
const version = "0.1.10-nightly.20261114.392";
const source = "a".repeat(40);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "t3-release-assets-"));
  const entries = ["dmg", "zip"].map((extension) => {
    const name = `T3-Code-Fork-${version}-arm64.${extension}`;
    const data = Buffer.from(`fixture ${extension}`);
    writeFileSync(join(dir, name), data);
    return { name, hash: createHash("sha512").update(data).digest("base64"), size: data.length };
  });
  const manifest = `version: ${version}\nfiles:\n${entries.map((entry) => `  - url: ${entry.name}\n    sha512: ${entry.hash}\n    size: ${entry.size}`).join("\n")}\npath: ${entries[1].name}\nsha512: ${entries[1].hash}\nreleaseDate: '2026-11-14T00:00:00.000Z'\n`;
  writeFileSync(join(dir, "nightly-mac.yml"), manifest);
  return { dir, manifest, entries };
}
test("checks every updater payload and writes source and checksum receipts", async () => {
  const { dir } = fixture();
  try {
    const assets = await verifyArtifacts(dir, version, source);
    assert.equal(assets.length, 5);
    assert.equal(JSON.parse(readFileSync(join(dir, "source.json"))).source, source);
    assert.equal(readFileSync(join(dir, "SHA256SUMS.txt"), "utf8").trim().split("\n").length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("rejects changed bytes, wrong versions, traversal and inconsistent legacy ZIP metadata", async () => {
  for (const alter of [
    ({ dir, entries }) => writeFileSync(join(dir, entries[0].name), "tampered"),
    ({ manifest }) => manifest.replace(`version: ${version}`, "version: 0.0.1"),
    ({ manifest, entries }) => manifest.replace(entries[0].name, "../outside.dmg"),
    ({ manifest, entries }) =>
      manifest.replace(`path: ${entries[1].name}`, `path: ${entries[0].name}`),
  ]) {
    const item = fixture();
    try {
      const changed = alter(item);
      if (typeof changed === "string") writeFileSync(join(item.dir, "nightly-mac.yml"), changed);
      await assert.rejects(verifyArtifacts(item.dir, version, source));
    } finally {
      rmSync(item.dir, { recursive: true, force: true });
    }
  }
});
