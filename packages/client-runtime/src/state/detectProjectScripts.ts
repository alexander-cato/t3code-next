import type { ProjectScript } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const packageManifest = Schema.fromJsonString(
  Schema.Struct({
    packageManager: Schema.optional(Schema.String),
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

export function detectProjectScripts(
  files: ReadonlySet<string>,
  manifest: string,
  idPrefix: string,
) {
  const commands = new Map<string, ProjectScript["icon"]>();
  const pkg = Option.getOrUndefined(Schema.decodeOption(packageManifest)(manifest));
  if (pkg?.scripts) {
    const managers = [
      ["pnpm", "pnpm-lock.yaml"],
      ["yarn", "yarn.lock"],
      ["bun", "bun.lock"],
      ["bun", "bun.lockb"],
    ] as const;
    const declared = pkg.packageManager?.split("@")[0];
    const manager =
      declared && ["npm", "pnpm", "yarn", "bun"].includes(declared)
        ? declared
        : (managers.find(([, lock]) => files.has(lock))?.[0] ?? "npm");
    for (const [name, icon] of [
      ["dev", "play"],
      ["start", "play"],
      ["build", "build"],
      ["test", "test"],
      ["lint", "lint"],
      ["typecheck", "lint"],
    ] as const) {
      if (pkg.scripts[name]?.trim()) commands.set(`${manager} run ${name}`, icon);
    }
  }
  for (const [file, build, test] of [
    ["Cargo.toml", "cargo build", "cargo test"],
    ["go.mod", "go build ./...", "go test ./..."],
    ["Package.swift", "swift build", "swift test"],
  ] as const) {
    if (files.has(file)) {
      commands.set(build, "build");
      commands.set(test, "test");
    }
  }
  return Array.from(commands, ([command, icon], index): ProjectScript => ({
    id: `${idPrefix}-${index}`,
    name: command,
    command,
    icon,
    runOnWorktreeCreate: false,
  }));
}
