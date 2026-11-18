import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

import { DevinSettings } from "../settings.ts";
import { DEVIN_ACP_FLAVOR } from "./devinAcp.ts";

export const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");
const DEFAULT_DEVIN_SETTINGS = Schema.decodeSync(DevinSettings)({});

/** The permission level each Devin session mode grants, so a managed ceiling can refuse Bypass. */
function devinRuntimeModeForSessionMode(modeId: string): RuntimeMode | undefined {
  switch (modeId) {
    case "ask":
    case "plan":
      return "approval-required";
    case "accept-edits":
      return "auto-accept-edits";
    case "smart":
      return "auto";
    case "bypass":
      return "full-access";
    default:
      return undefined;
  }
}

// The composer's chip rule, anchored to the message start, so `$25` never names a skill.
const LEADING_SKILL_MENTION = new RegExp(`^\\s*${SKILL_MENTION_PATTERN.source}`, "u");

/** Devin expands only a leading `/name`; the `$` picker inserts `$name` for one of its skills. */
export function devinSkillCommandText(text: string, skillNames: ReadonlySet<string>): string {
  const match = LEADING_SKILL_MENTION.exec(text);
  const name = match?.[2];
  if (match === null || name === undefined || !skillNames.has(name)) return text;
  return `/${name}${text.slice(match[0].length)}`;
}

interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn" | "customModels"
> {
  readonly settings: Pick<DevinSettings, "binaryPath" | "customModels">;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeDevinAcpRuntime = Effect.fn("makeDevinAcpRuntime")(function* (
  input: DevinAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { settings, environment, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: {
        command: settings.binaryPath || "devin",
        args: ["acp"],
        cwd: input.cwd,
        env: { ...environment },
      },
      customModels: readCustomModelEntries(settings.customModels).map((entry) => entry.slug),
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

export interface DevinAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: DevinSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  /** Skill names the provider snapshot listed, which a leading `$name` sends as `/name`. */
  readonly skillNames?: Effect.Effect<ReadonlySet<string>>;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
}

function makeDevinAcpAdapterFlavor(options: DevinAdapterV2Options): AcpAdapterV2Flavor {
  const skillNames = options.skillNames;
  return {
    ...DEVIN_ACP_FLAVOR,
    driver: DEVIN_DRIVER_KIND,
    runtimeHarness: "Devin",
    capabilities: AcpProviderCapabilitiesV2,
    customModels: readCustomModelEntries(options.settings.customModels).map((entry) => entry.slug),
    compactViaAdvertisedCommand: true,
    runtimeModeForSessionMode: devinRuntimeModeForSessionMode,
    ...(skillNames === undefined
      ? {}
      : {
          rewriteUserText: (text: string) =>
            skillNames.pipe(Effect.map((names) => devinSkillCommandText(text, names))),
        }),
    makeRuntime: ({ runtimePolicy: _runtimePolicy, processEnvironment, ...input }) =>
      makeDevinAcpRuntime({
        ...input,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      }),
  };
}

const makeDevinAdapterV2 = Effect.fn("makeDevinAdapterV2")(function* (
  options: DevinAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeDevinAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    clientTerminals: { environment: options.environment, shellCommands: true },
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
});

export type DevinAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeDevinAdapterV2Driver = (
  skillNames: Effect.Effect<ReadonlySet<string>>,
): ProviderAdapterDriver<DevinSettings, DevinAdapterV2DriverEnv> => ({
  driverKind: DEVIN_DRIVER_KIND,
  configSchema: DevinSettings,
  defaultConfig: (): DevinSettings => DEFAULT_DEVIN_SETTINGS,
  create: Effect.fn("DevinAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<DevinSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeDevinAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        skillNames,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: DEVIN_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: DEVIN_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the Devin ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
