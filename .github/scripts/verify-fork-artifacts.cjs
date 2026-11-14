const { createHash } = require("node:crypto");
const { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

async function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

async function verifyArtifacts(directory, version, source) {
  if (!/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(source)) {
    throw new Error("Expected a nightly version and pinned source SHA.");
  }
  const prefix = `T3-Code-Fork-${version}-arm64`;
  const required = [`${prefix}.dmg`, `${prefix}.zip`];
  const manifestPath = join(directory, "nightly-mac.yml");
  if (statSync(manifestPath).size > 100_000) throw new Error("Unexpected updater manifest size.");
  const manifest = readFileSync(manifestPath, "utf8").replaceAll("\r\n", "\n");
  if (manifest.match(/^version: (.+)$/m)?.[1] !== version)
    throw new Error("Updater version mismatch.");
  const entries = [
    ...manifest.matchAll(/^  - url: (.+)\n    sha512: ([A-Za-z0-9+/=]+)\n    size: (\d+)$/gm),
  ];
  if (
    entries.length !== 2 ||
    new Set(entries.map((entry) => entry[1])).size !== 2 ||
    entries.some((entry) => !required.includes(entry[1]))
  )
    throw new Error("Expected exactly the arm64 DMG and ZIP in the updater manifest.");
  for (const [, name, expectedHash, expectedSize] of entries) {
    const path = join(directory, name);
    if (
      statSync(path).size !== Number(expectedSize) ||
      (await digest(path, "sha512", "base64")) !== expectedHash
    ) {
      throw new Error(`Updater hash or size mismatch: ${name}.`);
    }
  }
  const zip = entries.find((entry) => entry[1].endsWith(".zip"));
  if (
    manifest.match(/^path: (.+)$/m)?.[1] !== zip[1] ||
    manifest.match(/^sha512: (.+)$/m)?.[1] !== zip[2]
  ) {
    throw new Error("Updater's default path and hash must identify the verified ZIP.");
  }
  const files = [
    "nightly-mac.yml",
    ...required,
    ...readdirSync(directory).filter((name) =>
      required.some((asset) => name === `${asset}.blockmap`),
    ),
  ].sort();
  const checksums = await Promise.all(
    files.map(async (name) => `${await digest(join(directory, name), "sha256", "hex")}  ${name}`),
  );
  writeFileSync(join(directory, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
  writeFileSync(
    join(directory, "source.json"),
    `${JSON.stringify({ repository: "alexander-cato/t3code-next", source, version, appId: "com.alexandercato.t3code.fork", platform: "darwin", arch: "arm64" }, null, 2)}\n`,
  );
  return [...files, "SHA256SUMS.txt", "source.json"];
}

if (require.main === module) {
  verifyArtifacts(...process.argv.slice(2))
    .then((files) => console.log(files.join("\n")))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { verifyArtifacts };
