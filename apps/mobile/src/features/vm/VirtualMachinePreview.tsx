import { virtualMachineViewerUrl } from "@t3tools/client-runtime/state/virtual-machines";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useState } from "react";
import { AppState, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { virtualMachineEnvironment as vm } from "../../state/virtualMachines";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { VirtualMachineStreamView } from "./VirtualMachineStreamView";

/** A macOS VM's desktop in the device preview. Opening it gives this thread control of the VM. */
export function VirtualMachinePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly name: string;
}) {
  const { environmentId, threadId, name } = props;
  const { themeVariables } = useAppearancePreferences();
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const open = useAtomCommand(vm.open, { reportFailure: false });
  const [attempt, setAttempt] = useState(0);
  const [viewer, setViewer] = useState<{ viewerPath: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestViewer = useEffectEvent(
    (
      target: {
        environmentId: EnvironmentId;
        threadId: ThreadId;
        name: string;
        /** A reconnect is a new attempt for the same VM. */
        attempt: number;
      },
      isCurrent: () => boolean,
    ) => {
      setViewer(null);
      setError(null);
      void open({
        environmentId: target.environmentId,
        input: { name: target.name, threadId: target.threadId },
      }).then((result) => {
        if (!isCurrent()) return;
        if (result._tag === "Failure") setError(String(Cause.squash(result.cause)));
        else
          setViewer({
            viewerPath: result.value.viewerPath,
            expiresAt: Date.now() + result.value.expiresInMs,
          });
      });
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the VM on the environment server and holds its viewer lease while shown
  useEffect(() => {
    let current = true;
    // oxlint-disable-next-line react/set-state-in-effect -- Each attempt clears the previous lease before its RPC starts.
    requestViewer({ environmentId, threadId, name, attempt }, () => current);
    return () => {
      current = false;
    };
  }, [attempt, environmentId, threadId, name]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expires the guest lease on its timer or when the native app resumes
  useEffect(() => {
    if (!viewer) return;
    const expire = () => {
      setViewer(null);
      setError("The VM view expired. Reconnect to continue.");
    };
    const timeout = setTimeout(expire, Math.max(0, viewer.expiresAt - Date.now()));
    // Native timers can pause while the app is in the background.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && viewer.expiresAt <= Date.now()) expire();
    });
    return () => {
      clearTimeout(timeout);
      subscription.remove();
    };
  }, [viewer]);

  if (viewer && prepared && !error)
    return (
      <VirtualMachineStreamView
        key={viewer.viewerPath}
        uri={virtualMachineViewerUrl(prepared.httpBaseUrl, viewer.viewerPath)}
        onFailure={setError}
      />
    );
  return (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      {error ? (
        <>
          <AppText
            selectable
            accessibilityRole="alert"
            className="text-center text-sm text-foreground-muted"
          >
            {error}
          </AppText>
          <Button
            label="Reconnect"
            tone="secondary"
            onPress={() => setAttempt((value) => value + 1)}
          />
        </>
      ) : (
        <>
          <AppActivityIndicator color={themeVariables["--color-icon"]} />
          <AppText className="text-sm text-foreground-muted">Connecting to {name}…</AppText>
        </>
      )}
    </View>
  );
}
