import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { virtualMachineViewerUrl } from "@t3tools/client-runtime/state/virtual-machines";
import type { ScopedThreadRef, VirtualMachineViewer } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { CircleAlert, Power, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  virtualMachineEnvironment as vm,
  useVirtualMachinesSupported,
} from "~/state/virtualMachines";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";
import { VirtualMachineControlsRail } from "./VirtualMachineControlsRail";
import {
  VirtualMachineViewer as GuestViewer,
  VirtualMachineStatusView as GuestStatusView,
  type VirtualMachineScreenSize,
} from "./VirtualMachineViewer";
import { takeVirtualMachineOpen, trackVirtualMachineOpen } from "./virtualMachinePanelSession";

export const isRunningVirtualMachine = (machine: { readonly status: string }) =>
  machine.status === "running" || machine.status === "ready";
// The server ends a viewer's stream when its lease expires, and reopening takes seconds,
// so renewal starts well before expiry.
const renewalDelay = (expiresInMs: number) =>
  Math.max(0, expiresInMs - Math.min(5 * 60_000, expiresInMs / 2));
type HeldViewer = VirtualMachineViewer & {
  readonly renewAt: number;
  readonly awaitingRunning: boolean;
};
const DOWNLOAD_URL_LIFETIME_MS = 60_000;

/** A panel tab, or the player floating over the thread's chat. */
export type VirtualMachineViewPlacement =
  | { readonly kind: "tab"; readonly surfaceId: string }
  | { readonly kind: "floating" };

/**
 * One macOS VM, shown like a device. Without a VM to show, a tab returns to the device list and
 * a floating player closes. A tab stays mounted while hidden, so `visible` gates opening, not the
 * stream.
 */
export function VirtualMachineDeviceView({
  threadRef,
  placement,
  name,
  visible,
  onScreen,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly placement: VirtualMachineViewPlacement;
  readonly name: string;
  readonly visible: boolean;
  readonly onScreen?: (screen: VirtualMachineScreenSize) => void;
}) {
  const { environmentId, threadId } = threadRef;
  const surfaceId = placement.kind === "tab" ? placement.surfaceId : null;
  const supported = useVirtualMachinesSupported(environmentId);
  const query = useEnvironmentQuery(supported ? vm.state({ environmentId, input: {} }) : null);
  const state = query.data;
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canOperate = useAtomValue(vm.open.permissionAtom(environmentId));
  const list = useAtomCommand(vm.list, { reportFailure: false });
  const open = useAtomCommand(vm.open, { reportFailure: false });
  const close = useAtomCommand(vm.close, { reportFailure: false });
  const stop = useAtomCommand(vm.stop, { reportFailure: false });
  const dismiss = useAtomCommand(vm.dismiss, { reportFailure: false });
  const screenshot = useAtomCommand(vm.screenshot, { reportFailure: false });
  const releaseControl = () =>
    close({ environmentId, input: { name, threadId } }).then((result) => {
      if (result._tag === "Failure")
        toastManager.add({
          type: "error",
          title: `Could not confirm ${name} disconnected`,
          description:
            "The view is closed, but VM control may still be connected on the server. " +
            formatEnvironmentQueryError(result.cause),
        });
    });
  const [viewer, setViewer] = useState<HeldViewer | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ message: string; connecting?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The subscription starts empty; only discovery can confirm that a VM is missing.
  const [missingFromInventory, setMissingFromInventory] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const [reopenedSession, setReopenedSession] = useState<string | null>(null);
  const [screenshotPending, setScreenshotPending] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retires pending desktop connection replies when the view unmounts
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const serverSession = state?.sessions.some(
    (entry) => entry.threadId === threadId && entry.name === name,
  );
  const machine = state?.machines.find((entry) => entry.name === name);
  const closedSession = state?.closedSessions?.find(
    (entry) => entry.threadId === threadId && entry.name === name,
  );
  const sessionClosed = closedSession !== undefined && reopenedSession !== closedSession.id;
  const stopped = machine?.status === "stopped" && !viewer?.awaitingRunning;
  // A suspended VM is never restarted for a view; only an explicit open starts it. A viewer this
  // tab just opened shows even before the inventory reports the VM running.
  const showing =
    !sessionClosed &&
    !stopped &&
    (viewer?.name === name ||
      (machine?.status !== "stopped" &&
        (serverSession || (machine !== undefined && isRunningVirtualMachine(machine)))));
  const failure = error ?? query.error;
  const floatingHere = () => {
    const source =
      usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.source;
    return source?.kind === "vm" && source.name === name;
  };
  const closeFloating = () => {
    if (floatingHere()) usePreviewMiniPlayerStore.getState().close(threadRef);
  };
  const leave = () => {
    if (surfaceId === null) closeFloating();
    else useRightPanelStore.getState().showDevicePicker(threadRef, surfaceId);
  };

  const invalidateViewer = () => {
    generation.current++;
    inFlight.current = null;
  };

  const openMachine = (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    setReopenedSession(closedSession?.id ?? null);
    const request = ++generation.current;
    // A reconnect keeps the mounted viewer and its recovery deadline.
    const loading = !viewer;
    if (loading) {
      setPending({
        message:
          machine && isRunningVirtualMachine(machine)
            ? "Connecting to desktop…"
            : "Starting macOS and preparing desktop input…",
        connecting: true,
      });
      setBusy(true);
    }
    setError(null);
    const finishOpening = trackVirtualMachineOpen(threadRef, name);
    const attempt = async () => {
      const result = await open({ environmentId, input: { name, threadId } });
      if (!mounted.current || request !== generation.current) {
        // Closing a floating player keeps control, as it does for devices.
        const released =
          surfaceId !== null &&
          !useRightPanelStore
            .getState()
            .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.some(
              (entry) => entry.id === surfaceId,
            );
        if (result._tag === "Success" && released) await releaseControl();
        return false;
      }
      if (result._tag === "Failure") {
        setError(formatEnvironmentQueryError(result.cause));
        return false;
      }
      if (result.value.expiresInMs <= 0) {
        setError("The desktop connection has expired. Try reconnecting.");
        return false;
      }
      setViewer({
        ...result.value,
        renewAt: Date.now() + renewalDelay(result.value.expiresInMs),
        awaitingRunning: machine?.status === "stopped",
      });
      if (state?.operations.some((entry) => entry.name === name && entry.status === "failed")) {
        const dismissed = await dismiss({ environmentId, input: { name } });
        if (mounted.current && request === generation.current && dismissed._tag === "Failure")
          setError(formatEnvironmentQueryError(dismissed.cause));
      }
      return true;
    };
    const promise = attempt().finally(() => {
      finishOpening();
      if (mounted.current && request === generation.current) {
        inFlight.current = null;
        if (loading) setBusy(false);
      }
    });
    inFlight.current = promise;
    return promise;
  };

  const stateLoaded = state != null;
  const openRequestedTab = useEffectEvent(() => {
    if (
      surfaceId !== null &&
      canOperate &&
      state?.enabled &&
      takeVirtualMachineOpen(threadRef, name)
    )
      void openMachine();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the VM of a tab the user just opened or restored, once the server's closed sessions are known
  useEffect(() => {
    if (stateLoaded && canOperate && state?.enabled) {
      // oxlint-disable-next-line react/set-state-in-effect -- Opening a requested tab starts an RPC and shows its pending state.
      openRequestedTab();
    }
  }, [stateLoaded, canOperate, state?.enabled]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- acknowledges the server's running inventory after an explicit Start reply arrives first
  useEffect(() => {
    if (viewer?.awaitingRunning && machine && isRunningVirtualMachine(machine)) {
      // oxlint-disable-next-line react/set-state-in-effect -- A later stopped inventory must retire a viewer whose startup has been acknowledged.
      setViewer((current) => current && { ...current, awaitingRunning: false });
    }
  }, [viewer?.awaitingRunning, machine]);

  const returnToDeviceList = useEffectEvent(
    (
      shown: boolean,
      operable: boolean,
      enabled: boolean | undefined,
      failed: string | null,
      retired: boolean,
    ) => {
      if (enabled === false) {
        invalidateViewer();
        if (surfaceId === null) closeFloating();
        else useRightPanelStore.getState().releaseVirtualMachineTabs(environmentId);
      } else if (((!shown && retired) || !operable) && !inFlight.current && failed === null)
        leave();
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaves the VM when the server reports it suspended, closed, deleted, or VM support turned off
  useEffect(() => {
    if (stateLoaded)
      returnToDeviceList(
        showing,
        canOperate,
        state?.enabled,
        error,
        sessionClosed || stopped || missingFromInventory,
      );
  }, [
    stateLoaded,
    showing,
    canOperate,
    state?.enabled,
    error,
    sessionClosed,
    stopped,
    missingFromInventory,
  ]);

  const refresh = useEffectEvent(() => {
    void list({ environmentId, input: {} }).then((result) => {
      if (!mounted.current) return;
      if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
      else
        setMissingFromInventory(
          !result.value.machines.some((entry) => entry.name === name) &&
            !result.value.sessions.some(
              (entry) => entry.name === name && entry.threadId === threadId,
            ),
        );
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the external VM inventory when the tab becomes visible
  useEffect(() => {
    if (visible && supported) refresh();
  }, [visible, supported]);

  const restoreViewer = useEffectEvent(() => {
    if (inFlight.current) return;
    if (viewer?.name === name && viewer.renewAt > Date.now()) return;
    void openMachine();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the external desktop viewer for the tab's server session
  useEffect(() => {
    if (visible && canOperate && state?.enabled && showing && machine?.status !== "stopped") {
      // oxlint-disable-next-line react/set-state-in-effect -- Restoring an external VM session starts an RPC and shows its pending state.
      restoreViewer();
    }
  }, [visible, canOperate, state?.enabled, showing, machine?.status]);

  const renewViewer = useEffectEvent(() => {
    if (showing) void openMachine();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- renews the external viewer lease before its credentials expire, hidden tabs included
  useEffect(() => {
    if (!canOperate || !state?.enabled || !viewer || !showing) return;
    const timeout = window.setTimeout(
      () => renewViewer(),
      Math.min(2_147_483_647, Math.max(0, viewer.renewAt - Date.now())),
    );
    return () => window.clearTimeout(timeout);
  }, [canOperate, state?.enabled, showing, viewer]);

  const suspendMachine = async () => {
    invalidateViewer();
    setPending({ message: "Suspending virtual machine…" });
    setBusy(true);
    setError(null);
    const result = await stop({ environmentId, input: { name } });
    if (!mounted.current) return;
    setBusy(false);
    if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
    else {
      useRightPanelStore.getState().releaseVirtualMachineTabs(environmentId, name);
      closeFloating();
    }
  };

  const closeView = () => {
    const opening = inFlight.current !== null && viewer === null;
    invalidateViewer();
    if (surfaceId === null) {
      closeFloating();
      return;
    }
    useRightPanelStore.getState().closeSurface(threadRef, surfaceId);
    if (!opening) void releaseControl();
  };

  const floatView = () => {
    usePreviewMiniPlayerStore.getState().open(threadRef, { kind: "vm", name });
    useRightPanelStore.getState().close(threadRef);
  };

  const saveScreenshot = async () => {
    if (screenshotPending) return;
    setScreenshotPending(true);
    // A capture always finishes, even if the tab hides or closes meanwhile; the user asked for it.
    const result = await screenshot({ environmentId, input: { name, threadId } });
    if (mounted.current) setScreenshotPending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not save screenshot",
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    const bytes = Uint8Array.from(atob(result.value.screenshot.data), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name.replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    // The browser reads the blob after the click returns.
    window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
  };

  const activeViewer = viewer && showing && state?.enabled ? viewer : null;
  const viewerUrl =
    activeViewer && prepared
      ? virtualMachineViewerUrl(prepared.httpBaseUrl, activeViewer.viewerPath)
      : null;
  const running = machine !== undefined && isRunningVirtualMachine(machine);

  const content = (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {failure && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <CircleAlert className="mt-1 size-3.5 shrink-0" />
          <div
            className="max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words"
            tabIndex={0}
          >
            {failure}
          </div>
          {error && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss virtual machine error"
              onClick={() => setError(null)}
            >
              <X />
            </Button>
          )}
        </div>
      )}
      {viewerUrl && activeViewer && !busy ? (
        <GuestViewer
          url={viewerUrl}
          name={name}
          onReconnect={async () => {
            if (!(await openMachine())) throw new Error("VM connection failed");
          }}
          onClose={closeView}
          {...(onScreen ? { onScreen } : {})}
          {...(surfaceId === null
            ? {}
            : {
                renderControls: (controls) => (
                  <VirtualMachineControlsRail
                    viewer={controls}
                    screenshotPending={screenshotPending}
                    onScreenshot={() => void saveScreenshot()}
                    onFloat={floatView}
                    onClose={closeView}
                    onSuspend={() => void suspendMachine()}
                  />
                ),
              })}
        />
      ) : (
        <GuestStatusView
          name={name}
          description="macOS virtual machine"
          error={!!failure && !busy}
          message={
            (busy
              ? pending?.message
              : failure
                ? "The desktop could not connect. Try reconnecting or close this view."
                : "Connecting to desktop…") ?? ""
          }
        >
          {pending?.connecting && busy && (
            <p className="max-w-xs text-xs text-muted-foreground">
              macOS startup can take a few minutes. Closing this view keeps the VM running.
            </p>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="sm" onClick={closeView}>
              Close view
            </Button>
            {failure && !busy && (
              <>
                <Button size="sm" disabled={!canOperate} onClick={() => void openMachine()}>
                  Retry connection
                </Button>
                {running && (
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    disabled={!canOperate}
                    aria-label={`Suspend ${name}`}
                    onClick={() => void suspendMachine()}
                  >
                    <Power /> Suspend
                  </Button>
                )}
              </>
            )}
          </div>
          {failure && !busy && (
            <p className="max-w-xs text-xs text-muted-foreground">
              Close keeps the VM running. Suspend releases CPU and memory and disconnects all open
              views of this VM.
            </p>
          )}
        </GuestStatusView>
      )}
    </div>
  );
  return surfaceId === null ? (
    <div className="flex size-full flex-col bg-background">{content}</div>
  ) : (
    <PreviewPanelShell mode="embedded">{content}</PreviewPanelShell>
  );
}
