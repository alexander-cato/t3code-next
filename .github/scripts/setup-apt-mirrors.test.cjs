const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("replaces GitHub runner mirror lists with HTTPS fallbacks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-apt-mirrors-"));
  try {
    fs.mkdirSync(path.join(root, "apt.conf.d"));
    fs.writeFileSync(
      path.join(root, "apt-mirrors.txt"),
      "http://azure.archive.ubuntu.com/ubuntu\n",
    );
    const action = fs.readFileSync(
      path.join(__dirname, "../actions/setup-apt-mirrors/action.yml"),
      "utf8",
    );
    const script = action.split("run: |\n")[1].replace(/^        /gm, "");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
      set -euo pipefail
      sudo() {
        local command="$1"; shift
        case "$command" in
          tee)
            local paths=()
            for target in "$@"; do paths+=("$TEST_APT_DIR/\${target#/etc/apt/}"); done
            command tee "\${paths[@]}" ;;
          find) return 0 ;;
          *) return 99 ;;
        esac
      }
      ${script}
    `,
      ],
      { env: { ...process.env, TEST_APT_DIR: root }, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const mirrors = fs.readFileSync(path.join(root, "apt-mirrors.txt"), "utf8");
    assert.doesNotMatch(mirrors, /azure\.archive/);
    assert.match(mirrors, /https:\/\/archive\.ubuntu\.com\/ubuntu/);
    assert.equal(
      mirrors,
      fs.readFileSync(path.join(root, "blacksmith-ubuntu-mirrors.txt"), "utf8"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
