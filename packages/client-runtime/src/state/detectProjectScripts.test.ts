import { describe, expect, it } from "vite-plus/test";
import { detectProjectScripts } from "./detectProjectScripts.ts";

describe("detectProjectScripts", () => {
  it("prefers the declared package manager and only saves supported, nonempty commands", () => {
    const scripts = detectProjectScripts(
      new Set(["yarn.lock"]),
      JSON.stringify({
        packageManager: "pnpm@10",
        scripts: { dev: "vite", test: "vitest", start: " ", postinstall: "generate" },
      }),
    );
    expect(scripts.map((script) => script.command)).toEqual(["pnpm run dev", "pnpm run test"]);
    expect(scripts.every((script) => !script.runOnWorktreeCreate)).toBe(true);
  });

  it("uses the lockfile when the manifest omits a package manager", () => {
    const scripts = detectProjectScripts(new Set(["bun.lock"]), '{"scripts":{"lint":"eslint"}}');
    expect(scripts.map((script) => script.command)).toEqual(["bun run lint"]);
  });

  it("detects native toolchains even when package.json is invalid", () => {
    expect(
      detectProjectScripts(new Set(["go.mod", "Cargo.toml", "Package.swift"]), "{").map(
        (script) => script.command,
      ),
    ).toEqual([
      "cargo build",
      "cargo test",
      "go build ./...",
      "go test ./...",
      "swift build",
      "swift test",
    ]);
    expect(detectProjectScripts(new Set(), "")).toEqual([]);
  });
});
