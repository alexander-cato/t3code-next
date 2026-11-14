import { DesktopInstallationDataStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopInstallationData from "../../app/DesktopInstallationData.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getInstallationDataState = makeIpcMethod({
  channel: IpcChannels.GET_INSTALLATION_DATA_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopInstallationDataStateSchema,
  handler: Effect.fn("desktop.ipc.installationData.getState")(function* () {
    return yield* (yield* DesktopInstallationData.DesktopInstallationData).getState;
  }),
});

export const importInstallationData = makeIpcMethod({
  channel: IpcChannels.IMPORT_INSTALLATION_DATA_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.installationData.import")(function* (directory) {
    yield* (yield* DesktopInstallationData.DesktopInstallationData).prepare(directory);
    yield* (yield* DesktopLifecycle.DesktopLifecycle).relaunch("installation-import");
  }),
});

export const restoreInstallationData = makeIpcMethod({
  channel: IpcChannels.RESTORE_INSTALLATION_DATA_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.installationData.restore")(function* (id) {
    yield* (yield* DesktopInstallationData.DesktopInstallationData).restore(id);
    yield* (yield* DesktopLifecycle.DesktopLifecycle).relaunch("installation-restore");
  }),
});
