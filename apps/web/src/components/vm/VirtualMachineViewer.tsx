import { Monitor } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

type ViewerStatus = "connecting" | "reconnecting" | "streaming" | "failed";

export interface VirtualMachineViewerControls {
  readonly streaming: boolean;
  /** A reconnect the user or the bounded retries started has not settled yet. */
  readonly reconnecting: boolean;
  readonly reconnect: () => void;
}

export interface VirtualMachineScreenSize {
  readonly width: number;
  readonly height: number;
}

export function VirtualMachineViewer(props: {
  readonly url: string;
  readonly name: string;
  readonly onReconnect: () => Promise<void>;
  readonly onClose: () => void;
  readonly onScreen?: (screen: VirtualMachineScreenSize) => void;
  /** Drawn beside the desktop in every connection state, as device views draw their rail. */
  readonly renderControls?: (controls: VirtualMachineViewerControls) => ReactNode;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const recovery = useRef<HTMLDivElement>(null);
  const ownsFocus = useRef(false);
  const reconnectRequest = useRef<{ name: string; promise: Promise<void> } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retires the outstanding desktop reconnect when the iframe host unmounts
  useEffect(
    () => () => {
      reconnectRequest.current = null;
    },
    [],
  );
  const frameUrl = props.url;
  const [connection, setConnection] = useState({
    url: frameUrl,
    name: props.name,
    status: "connecting" as ViewerStatus,
    timedOut: false,
    retries: 0,
    attempt: 0,
    requesting: false,
  });
  if (connection.name !== props.name) {
    setConnection({
      url: frameUrl,
      name: props.name,
      status: "connecting",
      timedOut: false,
      retries: 0,
      attempt: connection.attempt + 1,
      requesting: false,
    });
  } else if (connection.url !== frameUrl) {
    // Renewing the same VM's viewer lease must not restart its recovery budget.
    setConnection({ ...connection, url: frameUrl, status: "connecting" });
  }
  const { status, timedOut, retries, attempt, requesting } = connection;
  const streaming = status === "streaming";
  const needsRecovery = timedOut || (status === "failed" && retries >= 3 && !requesting);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps browser focus in this viewer when connection changes remove its focused recovery control or iframe
  useEffect(() => {
    if (!ownsFocus.current) return;
    const active = document.activeElement;
    if (active !== document.body && !host.current?.contains(active)) {
      ownsFocus.current = false;
      return;
    }
    (streaming ? frame.current : recovery.current)?.focus({ preventScroll: true });
  }, [streaming]);
  const requestReconnect = (expectedAttempt = attempt) => {
    if (reconnectRequest.current?.name === props.name) return;
    const attemptUrl = frameUrl;
    const requestName = props.name;
    setConnection((current) => ({ ...current, requesting: true }));
    const request = props
      .onReconnect()
      .catch(() => {
        if (reconnectRequest.current?.promise !== request) return;
        setConnection((current) =>
          current.url === attemptUrl &&
          current.attempt === expectedAttempt &&
          current.status !== "streaming"
            ? { ...current, status: "failed" }
            : current,
        );
      })
      .finally(() => {
        if (reconnectRequest.current?.promise !== request) return;
        reconnectRequest.current = null;
        setConnection((current) =>
          current.name === requestName && current.attempt === expectedAttempt
            ? { ...current, requesting: false }
            : current,
        );
      });
    reconnectRequest.current = { name: requestName, promise: request };
  };
  const retry = () => {
    if (reconnectRequest.current?.name === props.name) return;
    if (ownsFocus.current && host.current?.contains(document.activeElement))
      recovery.current?.focus({ preventScroll: true });
    setConnection((current) => ({
      ...current,
      status: "connecting",
      timedOut: false,
      retries: 0,
      attempt: current.attempt + 1,
    }));
    requestReconnect(attempt + 1);
  };
  const reconnect = useEffectEvent(() => requestReconnect());
  const reportScreen = useEffectEvent((screen: VirtualMachineScreenSize) =>
    props.onScreen?.(screen),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- bounds how long the external desktop stream can wait before offering recovery
  useEffect(() => {
    if (streaming) return;
    // Guest status chatter must not postpone the recovery controls indefinitely.
    const timeout = window.setTimeout(() => {
      setConnection((current) =>
        current.attempt === attempt ? { ...current, timedOut: true } : current,
      );
    }, 45_000);
    return () => window.clearTimeout(timeout);
  }, [streaming, attempt]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to source-validated status and size messages from the guest iframe
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== frame.current?.contentWindow ||
        typeof event.data !== "object" ||
        event.data === null
      )
        return;
      const data = event.data as {
        type?: unknown;
        status?: unknown;
        width?: unknown;
        height?: unknown;
      };
      if (data.type === "t3-vm-viewer-size") {
        if (
          typeof data.width === "number" &&
          typeof data.height === "number" &&
          data.width > 0 &&
          data.height > 0
        )
          reportScreen({ width: data.width, height: data.height });
        return;
      }
      if (
        data.type !== "t3-vm-viewer-status" ||
        (data.status !== "connecting" &&
          data.status !== "reconnecting" &&
          data.status !== "streaming" &&
          data.status !== "failed")
      )
        return;
      setConnection((current) => ({
        ...current,
        status: data.status as ViewerStatus,
        timedOut: data.status === "streaming" ? false : current.timedOut,
        retries: data.status === "streaming" ? 0 : current.retries,
      }));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules bounded reconnection attempts for the external desktop stream
  useEffect(() => {
    if (status !== "failed" || retries >= 3 || timedOut || requesting) return;
    const timeout = window.setTimeout(() => {
      setConnection((current) =>
        current.url === frameUrl && current.attempt === attempt
          ? { ...current, retries: current.retries + 1 }
          : current,
      );
      void reconnect();
    }, 2_000);
    return () => window.clearTimeout(timeout);
  }, [frameUrl, status, timedOut, retries, attempt, requesting]);
  const railed = props.renderControls !== undefined;
  return (
    <div
      ref={host}
      className={cn("relative flex min-h-0 min-w-0 flex-1", railed && "pr-14")}
      onFocusCapture={() => {
        ownsFocus.current = true;
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          ownsFocus.current = false;
      }}
    >
      <iframe
        ref={frame}
        key={`${props.name}:${frameUrl}`}
        title={`${props.name} macOS desktop`}
        inert={!streaming}
        tabIndex={streaming ? 0 : -1}
        src={frameUrl}
        className={cn(
          "min-h-0 min-w-0 flex-1 border-0",
          !streaming && "pointer-events-none opacity-0",
        )}
        // The guest serves this page, so it gets no host clipboard access.
        allow="fullscreen; keyboard-map"
        sandbox="allow-scripts allow-downloads allow-pointer-lock"
      />
      {!streaming && (
        <div
          ref={recovery}
          data-vm-focus-target
          tabIndex={-1}
          className={cn("absolute inset-0 flex outline-none", railed && "pr-14")}
        >
          <VirtualMachineStatusView
            name={props.name}
            description="macOS virtual machine"
            error={needsRecovery}
            message={
              needsRecovery
                ? requesting
                  ? "Still waiting for the connection attempt. You can close this view."
                  : "The desktop has not connected yet. Try reconnecting or close this view."
                : status === "reconnecting"
                  ? "Reconnecting to desktop…"
                  : "Connecting to desktop and preparing input…"
            }
          >
            {needsRecovery && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" size="sm" onClick={props.onClose}>
                  Close view
                </Button>
                <Button size="sm" onClick={retry} disabled={requesting} aria-busy={requesting}>
                  {requesting && <Spinner size="xs" aria-hidden="true" />}
                  {requesting ? "Reconnecting…" : "Retry connection"}
                </Button>
              </div>
            )}
          </VirtualMachineStatusView>
        </div>
      )}
      {props.renderControls ? (
        <ViewerControlsSlot
          renderControls={props.renderControls}
          streaming={streaming}
          reconnecting={requesting}
          onReconnect={retry}
        />
      ) : null}
    </div>
  );
}

// `retry` reads refs, so it reaches the controls as a prop instead of during the viewer's render.
function ViewerControlsSlot(props: {
  readonly renderControls: (controls: VirtualMachineViewerControls) => ReactNode;
  readonly streaming: boolean;
  readonly reconnecting: boolean;
  readonly onReconnect: () => void;
}) {
  return props.renderControls({
    streaming: props.streaming,
    reconnecting: props.reconnecting,
    reconnect: props.onReconnect,
  });
}

/** Mirrors DeviceLoadingView so VM connection states read like device ones. */
export function VirtualMachineStatusView(props: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly message: string;
  readonly error?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div
      role={props.error ? "alert" : "status"}
      data-vm-focus-target
      tabIndex={-1}
      className="scrollbar-gutter-both flex flex-1 items-start justify-center overflow-y-auto bg-background px-6 py-10"
    >
      <div className="my-auto flex w-full min-w-0 max-w-sm shrink-0 flex-col items-center gap-3 text-center">
        <div className="grid size-12 place-items-center rounded-xl border bg-muted/30">
          <Monitor className="size-6 text-muted-foreground" />
        </div>
        <div className="max-w-full space-y-1">
          <p className="break-words text-sm font-medium">{props.name}</p>
          {props.description && (
            <p className="text-xs text-muted-foreground">{props.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {!props.error && <Spinner size="xs" />}
          <span className="min-w-0 break-words">{props.message}</span>
        </div>
        {props.children}
      </div>
    </div>
  );
}
