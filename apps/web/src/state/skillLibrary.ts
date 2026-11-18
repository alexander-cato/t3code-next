import { WS_METHODS } from "@t3tools/contracts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";

export const skillLibraryList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:skills:list",
  tag: WS_METHODS.skillsList,
});

export const skillLibraryPreviewSource = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:skills:preview-source",
  tag: WS_METHODS.skillsPreviewSource,
});

/** Every change rescans the same folders; one at a time keeps each result the latest. */
export const skillLibraryMutate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:skills:mutate",
  tag: WS_METHODS.skillsMutate,
  scheduler: createAtomCommandScheduler(),
  concurrency: {
    mode: "serial",
    key: ({ environmentId }) => environmentId,
  },
  onSettled: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(skillLibraryList({ environmentId: target.environmentId, input: {} })),
    ),
});
