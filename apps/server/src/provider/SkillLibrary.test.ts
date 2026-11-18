import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type SkillLibraryMutation,
  type SkillLibrarySnapshot,
  type SkillName,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as SkillLibrary from "./SkillLibrary.ts";
import { readManifest } from "./skillLibraryManifest.ts";
import { parseSkillSourceUrl } from "./skillLibrarySources.ts";
import { buildUnavailableProviderSnapshot } from "./unavailableProviderSnapshot.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const cursor = ProviderDriverKind.make("cursor");
const devinInstance = ProviderInstanceId.make("acpRegistry_devin");
const name = (value: string) => value as SkillName;

const writeSkill = Effect.fn("writeSkill")(function* (directory: string, body = "") {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, "SKILL.md"),
    `---\nname: ${path.basename(directory)}\ndescription: The ${path.basename(directory)} skill.\n---\n${body}`,
  );
});

/**
 * A home where Claude, Codex, Cursor, and Devin (through the ACP Registry) are set up; `refreshed`
 * receives each provider rescan.
 */
const setup = Effect.fn("setup")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skill-library-" });
  const refreshed = yield* Queue.unbounded<string | undefined>();
  const providers = yield* Effect.forEach([claude, codex, cursor], (driverKind) =>
    buildUnavailableProviderSnapshot({
      driverKind,
      instanceId: ProviderInstanceId.make(driverKind),
      reason: "test",
      checkedAt: "2026-01-01T00:00:00.000Z",
    }).pipe(Effect.map((provider) => ({ ...provider, driver: driverKind }))),
  );
  const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed(providers),
    refresh: (driver) => Queue.offer(refreshed, driver).pipe(Effect.as(providers)),
    refreshInstance: (instanceId) => Queue.offer(refreshed, instanceId).pipe(Effect.as(providers)),
  });
  const settings = ServerSettingsService.layerTest({
    providerInstances: {
      [devinInstance]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        config: { agentId: "devin" },
      },
    },
  });
  const library = Context.get(
    yield* Layer.build(SkillLibrary.layer.pipe(Layer.provide([registry, settings]))),
    SkillLibrary.SkillLibrary,
  );
  const inHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, {}),
    );
  return {
    home,
    refreshed,
    list: inHome(library.list),
    mutate: (mutation: SkillLibraryMutation) => inHome(library.mutate(mutation)),
    preview: (url: string) => inHome(library.previewSource(url)),
    dirs: {
      catalog: path.join(home, ".agents", "skills", "skills"),
      claude: path.join(home, ".claude", "skills"),
      codex: path.join(home, ".codex", "skills"),
      cursor: path.join(home, ".cursor", "skills"),
      devin: path.join(home, ".config", "devin", "skills"),
    },
  };
});

const states = (snapshot: SkillLibrarySnapshot) =>
  Object.fromEntries(snapshot.skills.map((skill) => [skill.name, skill.targets]));

const writeJson = Effect.fn("writeJson")(function* (file: string, value: unknown) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, JSON.stringify(value));
});

const layerTest = Layer.mergeAll(
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-skill-library-git-" })),
    Layer.provideMerge(VcsProcess.layer),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.layer(layerTest)("SkillLibrary", (it) => {
  it.effect.skipIf(!symlinksSupported)(
    "links catalog skills, takes over links into the catalog, and leaves tools' own skills alone",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { refreshed, list, mutate, dirs } = yield* setup();
        yield* writeSkill(path.join(dirs.catalog, "review"));
        yield* writeSkill(path.join(dirs.catalog, "deploy"));
        yield* writeSkill(path.join(dirs.claude, "notes"));
        // Another manager's link into the catalog.
        yield* fileSystem.makeDirectory(dirs.cursor, { recursive: true });
        yield* fileSystem.symlink(
          path.join(dirs.catalog, "deploy"),
          path.join(dirs.cursor, "deploy"),
        );

        // Devin shows before its folder exists because T3 Code runs it.
        assert.deepEqual(states(yield* list), {
          deploy: { claude_code: "off", codex: "off", cursor: "linked", devin: "off" },
          notes: { claude_code: "external", codex: "off", cursor: "off", devin: "off" },
          review: { claude_code: "off", codex: "off", cursor: "off", devin: "off" },
        });

        yield* mutate({ _tag: "setTarget", name: name("review"), target: "codex", enabled: true });
        assert.strictEqual(
          yield* fileSystem.readLink(path.join(dirs.codex, "review")),
          path.join(dirs.catalog, "review"),
        );
        assert.strictEqual(yield* Queue.take(refreshed), codex);

        yield* mutate({ _tag: "setTarget", name: name("review"), target: "devin", enabled: true });
        assert.isTrue(yield* fileSystem.exists(path.join(dirs.devin, "review", "SKILL.md")));
        // Native Devin rescans by driver; a Devin run through the ACP Registry by its instance.
        assert.sameMembers(
          [yield* Queue.take(refreshed), yield* Queue.take(refreshed)],
          ["devin", devinInstance],
        );

        yield* mutate({
          _tag: "setTarget",
          name: name("deploy"),
          target: "cursor",
          enabled: false,
        });
        assert.isFalse(yield* fileSystem.exists(path.join(dirs.cursor, "deploy")));
        assert.isTrue(yield* fileSystem.exists(path.join(dirs.catalog, "deploy", "SKILL.md")));

        const refused = yield* mutate({
          _tag: "setTarget",
          name: name("notes"),
          target: "claude_code",
          enabled: false,
        }).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "not-owned");

        const adopted = yield* mutate({
          _tag: "adopt",
          name: name("notes"),
          target: "claude_code",
        });
        assert.strictEqual(
          adopted.skills.find((skill) => skill.name === "notes")?.catalogPath,
          path.join(dirs.catalog, "notes"),
        );
        assert.isTrue(yield* fileSystem.exists(path.join(dirs.claude, "notes", "SKILL.md")));
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "imports skills-manager.app's sources and scenarios, then relinks on a scenario switch",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { list, mutate, dirs } = yield* setup();
        const exported = path.join(dirs.catalog, ".skills-manager");
        yield* writeSkill(path.join(dirs.catalog, "alpha"));
        yield* writeSkill(path.join(dirs.catalog, "beta"));
        yield* writeJson(path.join(exported, "skills", "1.json"), {
          skill_id: "1",
          path: "alpha",
          source: {
            type: "git",
            ref: "https://github.com/acme/skills/tree/main",
            subpath: "skills/alpha",
            branch: "main",
          },
        });
        yield* writeJson(path.join(exported, "skills", "2.json"), {
          skill_id: "2",
          path: "beta",
          source: { type: "skillssh", ref: "acme/more/beta", subpath: "beta", branch: null },
        });
        yield* writeJson(path.join(exported, "scenarios", "d.json"), {
          scenario_id: "d",
          name: "Default",
          sort_order: 0,
        });
        yield* writeJson(path.join(exported, "scenarios", "w.json"), {
          scenario_id: "w",
          name: "Work",
          sort_order: 1,
        });
        // Lists tools that are not installed, which must not count against it.
        yield* writeJson(path.join(exported, "scenario-skills", "d", "1.json"), {
          skill_id: "1",
          tools: { claude_code: true, codex: true, windsurf: true, junie: true, augment: true },
        });
        yield* writeJson(path.join(exported, "scenario-skills", "w", "2.json"), {
          skill_id: "2",
          tools: { cursor: true },
        });
        // The app does not export which scenario is active; the links on disk say Default.
        yield* fileSystem.makeDirectory(dirs.claude, { recursive: true });
        yield* fileSystem.symlink(
          path.join(dirs.catalog, "alpha"),
          path.join(dirs.claude, "alpha"),
        );
        // skills-manager.app has no Devin; its scenarios must keep this link.
        yield* fileSystem.makeDirectory(dirs.devin, { recursive: true });
        yield* fileSystem.symlink(path.join(dirs.catalog, "beta"), path.join(dirs.devin, "beta"));
        assert.isTrue((yield* list).canImportSkillsManager);

        const imported = yield* mutate({ _tag: "importSkillsManager" });
        assert.strictEqual(imported.activeScenario, "Default");
        assert.isFalse(imported.canImportSkillsManager);
        assert.deepEqual(
          imported.skills.map((skill) => [skill.name, skill.source]),
          [
            [
              "alpha",
              { repository: "https://github.com/acme/skills", ref: "main", path: "skills/alpha" },
            ],
            ["beta", { repository: "https://github.com/acme/more", path: "beta" }],
          ],
        );
        // Importing changes no links.
        assert.deepEqual(states(imported).alpha, {
          claude_code: "linked",
          codex: "off",
          cursor: "off",
          devin: "off",
        });

        const switched = yield* mutate({ _tag: "activateScenario", name: "Work" });
        assert.deepEqual(states(switched), {
          alpha: { claude_code: "off", codex: "off", cursor: "off", devin: "off" },
          beta: { claude_code: "off", codex: "off", cursor: "linked", devin: "linked" },
        });

        // A toggle edits the active scenario, so switching back and forth keeps it.
        yield* mutate({ _tag: "setTarget", name: name("alpha"), target: "codex", enabled: true });
        yield* mutate({ _tag: "activateScenario", name: "Default" });
        const back = yield* mutate({ _tag: "activateScenario", name: "Work" });
        assert.deepEqual(states(back), {
          alpha: { claude_code: "off", codex: "linked", cursor: "off", devin: "off" },
          beta: { claude_code: "off", codex: "off", cursor: "linked", devin: "linked" },
        });

        yield* mutate({ _tag: "delete", name: name("beta") });
        assert.isFalse(yield* fileSystem.exists(path.join(dirs.cursor, "beta")));
        const manifest = yield* readManifest(dirs.catalog);
        assert.deepEqual(
          manifest.pipe((option) => (option._tag === "Some" ? option.value.scenarios : null)),
          {
            Default: { alpha: ["claude_code", "codex", "junie", "windsurf"] },
            Work: { alpha: ["codex"] },
          },
        );
      }),
  );

  it.effect("installs from a git repository and applies upstream changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const { home, mutate, preview, dirs } = yield* setup();
      const repo = path.join(home, "upstream");
      const commit = (message: string) =>
        Effect.forEach(
          [
            ["add", "-A"],
            ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message],
          ],
          (args) => git.execute({ operation: "test", cwd: repo, args }),
          { discard: true },
        );
      yield* writeSkill(path.join(repo, "skills", "alpha"), "v1\n");
      yield* writeSkill(path.join(repo, "skills", "beta"));
      yield* git.execute({ operation: "test", cwd: repo, args: ["init", "-q", "-b", "main"] });
      yield* commit("one");
      const url = `file://${repo}`;

      const offered = yield* preview(url);
      assert.deepEqual(
        offered.candidates.map((candidate) => [candidate.name, candidate.path]),
        [
          ["alpha", "skills/alpha"],
          ["beta", "skills/beta"],
        ],
      );

      const installed = yield* mutate({ _tag: "install", url, names: [name("alpha")] });
      assert.deepEqual(
        installed.skills.map((skill) => skill.name),
        ["alpha"],
      );
      assert.deepEqual(installed.skills[0]?.source, { repository: url, path: "skills/alpha" });

      yield* writeSkill(path.join(repo, "skills", "alpha"), "v2\n");
      yield* commit("two");
      const checked = yield* mutate({ _tag: "checkUpdates" });
      assert.strictEqual(checked.skills[0]?.update?.status, "available");

      const updated = yield* mutate({ _tag: "update", name: name("alpha") });
      assert.strictEqual(updated.skills[0]?.update?.status, "current");
      assert.include(
        yield* fileSystem.readFileString(path.join(dirs.catalog, "alpha", "SKILL.md")),
        "v2",
      );
    }),
  );

  it.effect("backs up the catalog and catches up with another machine's backup", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const { home, mutate, dirs } = yield* setup();
      const run = (cwd: string, ...args: string[]) =>
        git.execute({
          operation: "test",
          cwd,
          args: ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        });
      const remote = path.join(home, "remote.git");
      const other = path.join(home, "other");
      yield* fileSystem.makeDirectory(remote);
      yield* run(remote, "init", "-q", "--bare", "-b", "main");
      yield* writeSkill(path.join(dirs.catalog, "alpha"));
      yield* run(dirs.catalog, "init", "-q", "-b", "main");
      yield* run(dirs.catalog, "remote", "add", "origin", remote);

      assert.deepEqual((yield* mutate({ _tag: "setBackup", enabled: true })).backup, {
        enabled: true,
      });
      yield* mutate({ _tag: "backUp" });

      yield* run(home, "clone", "-q", remote, other);
      yield* writeSkill(path.join(other, "beta"));
      yield* run(other, "add", "-A");
      yield* run(other, "commit", "-qm", "beta");
      yield* run(other, "push", "-q", "origin", "main");
      yield* writeSkill(path.join(dirs.catalog, "gamma"));

      const backedUp = yield* mutate({ _tag: "backUp" });
      assert.isUndefined(backedUp.backup?.error);
      assert.isDefined(backedUp.backup?.lastBackupAt);
      assert.deepEqual(
        backedUp.skills.map((skill) => skill.name),
        ["alpha", "beta", "gamma"],
      );
      yield* run(other, "fetch", "-q");
      assert.deepEqual(
        (yield* run(other, "log", "--format=%s", "origin/main")).stdout.trim().split("\n"),
        ["Back up skills", "beta", "Back up skills"],
      );
    }),
  );
});

it("reads GitHub, shorthand, and other git source URLs", () => {
  assert.deepEqual(
    [
      "https://github.com/acme/skills",
      "https://github.com/acme/skills.git/",
      "https://github.com/acme/skills/tree/main/skills/review",
      "https://github.com/acme/skills/blob/dev/review/SKILL.md",
      "acme/skills/review",
      "git@gitlab.com:acme/skills.git",
      "not a url",
    ].map(parseSkillSourceUrl),
    [
      { repository: "https://github.com/acme/skills" },
      { repository: "https://github.com/acme/skills" },
      { repository: "https://github.com/acme/skills", ref: "main", path: "skills/review" },
      { repository: "https://github.com/acme/skills", ref: "dev", path: "review" },
      { repository: "https://github.com/acme/skills", path: "review" },
      { repository: "git@gitlab.com:acme/skills.git" },
      undefined,
    ],
  );
});
