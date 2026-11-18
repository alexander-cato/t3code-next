import type * as EffectAcpSchema from "effect-acp/compat";
import type {
  ProviderOptionDescriptor,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import type { AcpSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import { findModelConfigOption } from "@t3tools/provider-acp/server/runtimeModel";
import {
  acpProviderOptionDescriptors,
  flattenSelectChoices,
} from "@t3tools/provider-acp/server/sessionConfig";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  parseCliVersionResult,
  type ProviderProbeResult,
  providerModelsFromSettings,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

import type { DevinSettings } from "../settings.ts";
import { DEVIN_DRIVER_KIND, makeDevinAcpRuntime } from "./adapter.ts";

const DEVIN_PRESENTATION = { displayName: "Devin" } as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const DEVIN_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Devin default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const SESSION_PROBE_TIMEOUT_MS = 30_000;
const COMMAND_ADVERTISEMENT_GRACE = "2 seconds";
const SESSION_DELETE_TIMEOUT = "2 seconds";

interface DevinDiscovery {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const snapshot = (
  settings: DevinSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  discovery?: DevinDiscovery,
): ServerProviderDraft => ({
  ...buildServerProvider({
    driver: DEVIN_DRIVER_KIND,
    presentation: DEVIN_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(
      discovery?.models ?? DEVIN_FALLBACK_MODELS,
      settings.customModels,
      EMPTY_CAPABILITIES,
    ),
    ...(discovery === undefined
      ? {}
      : { slashCommands: discovery.slashCommands, skills: discovery.skills }),
    probe,
  }),
  // Devin keeps every ACP session it opens, so a text-generation session would stay listed.
  supportsTextGeneration: false,
});

export const buildInitialDevinProviderSnapshot = (
  settings: DevinSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Devin CLI availability..."
        : "Devin is disabled in T3 Code settings.",
    }),
  );

const runDevinCli = Effect.fn("DevinProvider.runDevinCli")(function* (
  settings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "devin";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

/** Reads `devin auth status`, which prints `Logged in (via …).` or `Not logged in.`. */
function devinAuthFromStatus(
  output: { readonly code: number; readonly stdout: string; readonly stderr: string } | undefined,
): ServerProviderAuth {
  if (output === undefined) return { status: "unknown" };
  const text = `${output.stdout}\n${output.stderr}`;
  if (/\bnot logged in\b/iu.test(text)) return { status: "unauthenticated" };
  return output.code === 0 && /^\s*logged in\b/imu.test(text)
    ? { status: "authenticated", label: "Devin account" }
    : { status: "unknown" };
}

/**
 * Devin lists one model choice per family; its thinking level and speed options describe
 * only the session's current model, so other models carry the shared options alone.
 */
function devinModelsFromSession(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  modeState: AcpSessionModeState | undefined,
): ReadonlyArray<ServerProviderModel> | undefined {
  const modelOption = findModelConfigOption(configOptions);
  if (modelOption === undefined) return undefined;
  const descriptors = acpProviderOptionDescriptors({ configOptions, modeState });
  const modelSpecificIds = new Set(
    configOptions
      .filter((option) => option.category === "thought_level" || option.category === "model_config")
      .map((option) => option.id),
  );
  const shared = descriptors.filter((descriptor) => !modelSpecificIds.has(descriptor.id));
  const capabilities = (optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>) =>
    optionDescriptors.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors: [...optionDescriptors] });
  const seen = new Set<string>();
  const models = flattenSelectChoices(modelOption.options).flatMap((choice) => {
    const slug = choice.value.trim();
    if (slug.length === 0 || seen.has(slug)) return [];
    seen.add(slug);
    const isCurrent = slug === modelOption.currentValue;
    return [
      {
        slug,
        name: choice.name.trim() || slug,
        isCustom: false,
        ...(isCurrent ? { isDefault: true } : {}),
        capabilities: capabilities(isCurrent ? descriptors : shared),
      } satisfies ServerProviderModel,
    ];
  });
  return models.length === 0 ? undefined : models;
}

/** Devin advertises its skills as commands in its `Skills` category. */
function devinCommandsFromSession(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): Pick<DevinDiscovery, "slashCommands" | "skills"> {
  const seen = new Set<string>();
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    const name = command.name.trim();
    if (name.length === 0) continue;
    const description = command.description.trim();
    const isSkill = command._meta?.["cognition.ai/category"] === "Skills";
    const key = `${isSkill ? "skill" : "command"}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isSkill) {
      skills.push({
        name,
        ...(description ? { description } : {}),
        path: `devin://skill/${encodeURIComponent(name)}`,
        scope: "agent",
        enabled: true,
      });
      continue;
    }
    const hint = command.input && "hint" in command.input ? command.input.hint.trim() : "";
    slashCommands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return { slashCommands, skills };
}

/**
 * Opens one Devin ACP session to read its models, options and commands, then deletes it,
 * since Devin keeps every session it creates. No prompt is sent.
 */
const discoverDevinSession = Effect.fn("DevinProvider.discoverDevinSession")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) {
  const runtime = yield* makeDevinAcpRuntime({
    settings,
    environment,
    cwd: yield* HostProcess.WorkingDirectory,
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    authenticateOnAuthRequired: false,
  });
  const commands = yield* Ref.make<ReadonlyArray<EffectAcpSchema.AvailableCommand>>([]);
  const commandsAdvertised = yield* Deferred.make<void>();
  yield* runtime.handleSessionUpdate((notification) =>
    notification.update.sessionUpdate === "available_commands_update"
      ? Ref.set(commands, notification.update.availableCommands).pipe(
          Effect.andThen(Deferred.succeed(commandsAdvertised, undefined)),
          Effect.asVoid,
        )
      : Effect.void,
  );
  const started = yield* runtime.start();
  yield* Effect.addFinalizer(() =>
    runtime
      .deleteSession(started.sessionId)
      .pipe(Effect.timeoutOption(SESSION_DELETE_TIMEOUT), Effect.ignore),
  );
  yield* Deferred.await(commandsAdvertised).pipe(Effect.timeoutOption(COMMAND_ADVERTISEMENT_GRACE));
  return {
    models: devinModelsFromSession(yield* runtime.getConfigOptions, yield* runtime.getModeState),
    ...devinCommandsFromSession(yield* Ref.get(commands)),
  };
}, Effect.scoped);

/**
 * Reads `devin --version` and `devin auth status`, then, once signed in, opens a throwaway
 * ACP session for the account's models, session options, slash commands and skills.
 */
export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Devin is disabled in T3 Code settings.",
    });
  }

  const probeEnvironment = providerProbeEnvironment(environment);
  const versionResult = yield* runDevinCli(settings, ["--version"], probeEnvironment).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("devin", VERSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Devin CLI (`devin`) is not installed or not on PATH."
        : "Failed to run `devin --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseCliVersionResult(versionOutput);
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Devin CLI is installed but failed to run.",
    });
  }

  const authResult = yield* runDevinCli(settings, ["auth", "status"], probeEnvironment).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("devin", AUTH_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  const auth = devinAuthFromStatus(
    Result.isSuccess(authResult) ? Option.getOrUndefined(authResult.success) : undefined,
  );
  if (auth.status === "unauthenticated") {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth,
      message: "Devin CLI is installed but not signed in. Run `devin auth login`.",
    });
  }
  if (auth.status !== "authenticated") {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "warning",
      auth,
      message: "Could not confirm the Devin sign-in. Run `devin auth status` to check.",
    });
  }

  const discovery = yield* discoverDevinSession(settings, probeEnvironment).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("devin", SESSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.map(Option.getOrUndefined),
    Effect.tapError((cause) => Effect.logWarning("Devin ACP discovery failed.", { cause })),
    Effect.orElseSucceed(() => undefined),
  );
  const models = discovery?.models;
  // A ready snapshot replaces cached models, so only a completed model listing is ready.
  if (discovery === undefined || models === undefined) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "warning",
      auth,
      message:
        "Devin CLI is signed in but did not list its models. Model options may be incomplete.",
    });
  }
  return snapshot(
    settings,
    checkedAt,
    { installed: true, version, status: "ready", auth },
    { ...discovery, models },
  );
});

/** Skill names the snapshot listed, for the adapter's `$name` to `/name` rewrite. */
export const devinSkillNames = (skills: ReadonlyArray<ServerProviderSkill> | undefined) =>
  new Set((skills ?? []).filter((skill) => skill.enabled).map((skill) => skill.name));
