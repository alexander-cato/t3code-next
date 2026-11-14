import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type VirtualMachineState,
  type VirtualMachineViewer,
} from "@t3tools/contracts";
import { StrictMode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import { toastManager } from "~/components/ui/toast";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { reopenClosedView } from "~/reopenClosedView";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { VirtualMachineDeviceView } from "./VirtualMachineDeviceView";
import { requestVirtualMachineOpen } from "./virtualMachinePanelSession";
import { VirtualMachineTabs } from "./VirtualMachineTabs";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  open: vi.fn(),
  dismiss: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  screenshot: vi.fn(),
  allowed: true,
  state: null as VirtualMachineState | null,
  listeners: new Set<() => void>(),
  connected: false,
}));
// The real query notifies subscribers; a re-rendered parent alone does not reach a memoized view.
function publishState(next: Partial<VirtualMachineState>) {
  mocks.state = { ...state, ...mocks.state, ...next };
  for (const listener of mocks.listeners) listener();
}
const state: VirtualMachineState = {
  enabled: true,
  available: true,
  unavailableReason: null,
  machines: [],
  sessions: [],
  operations: [],
};
vi.mock("~/state/virtualMachines", async () => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  const denied = Atom.make(false);
  const command = (label: string) => ({
    label,
    permissionAtom: () => (mocks.allowed ? permission : denied),
  });
  return {
    useVirtualMachinesSupported: () => true,
    virtualMachineEnvironment: {
      state: () => null,
      list: command("list"),
      configure: command("configure"),
      create: command("create"),
      open: command("open"),
      close: command("close"),
      stop: command("stop"),
      remove: command("remove"),
      dismiss: command("dismiss"),
      screenshot: command("screenshot"),
    },
  };
});
vi.mock("~/state/query", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  };
  return {
    ...(await importOriginal<typeof import("~/state/query")>()),
    useEnvironmentQuery: () => ({
      data: useSyncExternalStore(subscribe, () => mocks.state),
      error: null,
      refresh: () => {},
    }),
    formatEnvironmentQueryError: () => "VM command failed",
  };
});
vi.mock("~/state/session", async (importOriginal) => {
  const Option = await import("effect/Option");
  return {
    ...(await importOriginal<typeof import("~/state/session")>()),
    usePreparedConnection: () =>
      mocks.connected ? Option.some({ httpBaseUrl: "http://vm.test" }) : Option.none(),
  };
});
vi.mock("~/state/use-atom-command", () => ({
  // Commands have a fresh identity each render, as useAtomCommand does.
  useAtomCommand: (command: { label: string }) => (input: unknown) => {
    if (command.label === "list") return mocks.list(input);
    if (command.label === "open") return mocks.open(input);
    if (command.label === "dismiss") return mocks.dismiss(input);
    if (command.label === "stop") return mocks.stop(input);
    if (command.label === "close") return mocks.close(input);
    if (command.label === "screenshot") return mocks.screenshot(input);
    return Promise.resolve({ _tag: "Success", value: {} });
  },
}));

function setup() {
  useRightPanelStore.setState({ byThreadKey: {} });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  mocks.connected = true;
  mocks.allowed = true;
  mocks.state = state;
  mocks.list.mockReset().mockResolvedValue({ _tag: "Success", value: state });
  mocks.open.mockReset();
  mocks.stop.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  mocks.close.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  mocks.dismiss.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
}

const viewer = (viewerPath: string, name = "selected-mac") =>
  ({ _tag: "Success", value: { name, viewerPath, expiresInMs: 3_600_000 } }) as const;

function pendingViewer() {
  type Result =
    | { _tag: "Success"; value: VirtualMachineViewer }
    | { _tag: "Failure"; cause: object };
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function threadRefFor(name: string): ScopedThreadRef {
  return { environmentId: EnvironmentId.make(`${name}-env`), threadId: ThreadId.make(name) };
}

/** Renders the thread's active tab the way the right panel does. */
function ActiveTab({
  threadRef,
  visible = true,
}: {
  threadRef: ScopedThreadRef;
  visible?: boolean;
}) {
  const surface = useRightPanelStore((store) =>
    selectActiveRightPanelSurface(store.byThreadKey, threadRef),
  );
  if (surface?.kind !== "device") return <div>no device tab</div>;
  if (surface.virtualMachine === undefined) return <div>device list</div>;
  return (
    <VirtualMachineDeviceView
      key={`${scopedThreadKey(threadRef)}:${surface.id}`}
      threadRef={threadRef}
      placement={{ kind: "tab", surfaceId: surface.id }}
      name={surface.virtualMachine}
      visible={visible}
    />
  );
}

const iframe = (screen: { container: HTMLElement }) => screen.container.querySelector("iframe");

it("closes the tab before server cleanup settles and reports cleanup failure", async () => {
  setup();
  const threadRef = threadRefFor("close");
  mocks.state = { ...state, machines: [{ name: "selected-mac", status: "running" }] };
  mocks.open.mockResolvedValue(viewer("/viewer"));
  const cleanup = pendingViewer();
  mocks.close.mockReturnValue(cleanup.promise);
  requestVirtualMachineOpen(threadRef, "selected-mac");
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  using notify = vi.spyOn(toastManager, "add").mockReturnValue("vm-cleanup-error");
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  await screen.getByRole("button", { name: "More VM actions", exact: true }).click();
  await screen.getByRole("menuitem", { name: "Close VM view" }).click();
  await expect.element(screen.getByText("no device tab")).toBeVisible();
  cleanup.resolve({ _tag: "Failure", cause: {} });
  await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  expect(mocks.open).toHaveBeenCalledTimes(1);
});

it("waits for a cold query before consuming the requested VM open", async () => {
  setup();
  mocks.state = null;
  const threadRef = threadRefFor("cold-query");
  mocks.open.mockResolvedValue(viewer("/cold-viewer"));
  requestVirtualMachineOpen(threadRef, "selected-mac");
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await expect.element(screen.getByText("device list", { exact: true })).not.toBeInTheDocument();
  expect(mocks.open).not.toHaveBeenCalled();
  await act(() => publishState({ machines: [{ name: "selected-mac", status: "stopped" }] }));
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  expect(mocks.open).toHaveBeenCalledTimes(1);
});

it("retires a started viewer after a later stopped inventory without a close marker", async () => {
  setup();
  const threadRef = threadRefFor("external-suspend");
  mocks.state = { ...state, machines: [{ name: "selected-mac", status: "stopped" }] };
  mocks.open.mockResolvedValue(viewer("/started-viewer"));
  requestVirtualMachineOpen(threadRef, "selected-mac");
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  await act(() =>
    publishState({
      machines: [{ name: "selected-mac", status: "running" }],
      sessions: [{ name: "selected-mac", threadId: threadRef.threadId }],
    }),
  );
  await act(() => publishState({ machines: [{ name: "selected-mac", status: "stopped" }] }));
  await expect.element(screen.getByText("device list", { exact: true })).toBeVisible();
  expect(iframe(screen)).toBeNull();
  expect(mocks.open).toHaveBeenCalledTimes(1);
});

it("returns to the device list instead of waiting when this connection cannot operate VMs", async () => {
  setup();
  mocks.allowed = false;
  const threadRef = threadRefFor("readonly");
  mocks.state = {
    ...state,
    machines: [{ name: "selected-mac", status: "running" }],
    sessions: [{ name: "selected-mac", threadId: threadRef.threadId }],
  };
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await expect.element(screen.getByText("device list")).toBeVisible();
  expect(mocks.open).not.toHaveBeenCalled();
});

it("restores the desktop after a tab remount", async () => {
  setup();
  const threadRef = threadRefFor("restore");
  mocks.state = {
    ...state,
    machines: [{ name: "selected-mac", status: "running" }],
    sessions: [{ name: "selected-mac", threadId: threadRef.threadId }],
  };
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  const opened = pendingViewer();
  mocks.open.mockReturnValue(opened.promise);
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await expect.element(screen.getByText("Connecting to desktop…", { exact: true })).toBeVisible();
  opened.resolve(viewer("/viewer"));
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  await screen.rerender(<div>Other panel tab</div>);
  mocks.open.mockResolvedValue(viewer("/renewed-viewer"));
  await screen.rerender(<ActiveTab threadRef={threadRef} />);
  await vi.waitFor(() => expect(iframe(screen)?.getAttribute("src")).toContain("/renewed-viewer"));
});

it("restores the desktop through StrictMode effect replay without opening it twice", async () => {
  setup();
  const threadRef = threadRefFor("strict");
  mocks.state = {
    ...state,
    machines: [{ name: "selected-mac", status: "running" }],
    sessions: [{ name: "selected-mac", threadId: threadRef.threadId }],
  };
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  const opened = pendingViewer();
  mocks.open.mockReturnValue(opened.promise);
  await using screen = await render(
    <StrictMode>
      <ActiveTab threadRef={threadRef} />
    </StrictMode>,
    // StrictMode must wrap the root to replay initial effects as the app does.
    { router: false },
  );
  expect(mocks.open).toHaveBeenCalledTimes(1);
  await act(async () => {
    opened.resolve(viewer("/strict-viewer"));
    await opened.promise;
  });
  await vi.waitFor(() => expect(iframe(screen)?.getAttribute("src")).toContain("/strict-viewer"));
  expect(mocks.open).toHaveBeenCalledTimes(1);
});

it("keeps the VM tab after a StrictMode restore failure and lets the user reconnect", async () => {
  setup();
  const threadRef = threadRefFor("recovery");
  mocks.state = {
    ...state,
    machines: [{ name: "selected-mac", status: "running" }],
    sessions: [{ name: "selected-mac", threadId: threadRef.threadId }],
  };
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  mocks.open.mockResolvedValue({ _tag: "Failure", cause: {} });
  await using screen = await render(
    <StrictMode>
      <ActiveTab threadRef={threadRef} />
    </StrictMode>,
    // StrictMode must wrap the root to replay initial effects as the app does.
    { router: false },
  );
  await expect
    .element(screen.getByRole("button", { name: "Retry connection", exact: true }))
    .toBeVisible();
  mocks.open.mockResolvedValue(viewer("/reconnected-viewer"));
  await userEvent.click(screen.getByRole("button", { name: "Retry connection", exact: true }));
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it.each([
  ["stopped", "Starting macOS and preparing desktop input…"],
  ["running", "Connecting to desktop…"],
])(
  "opens a %s guest left by a failed creation, then clears the failure",
  async (status, message) => {
    setup();
    const threadRef = threadRefFor(`failed-creation-${status}`);
    mocks.state = {
      ...state,
      machines: [{ name: "registered-guest", status }],
      operations: [{ name: "registered-guest", status: "failed", error: "macOS VM limit reached" }],
    };
    const opened = pendingViewer();
    mocks.open.mockReturnValue(opened.promise);
    requestVirtualMachineOpen(threadRef, "registered-guest");
    useRightPanelStore.getState().openVirtualMachine(threadRef, "registered-guest");
    await using screen = await render(<ActiveTab threadRef={threadRef} />);
    await expect.element(screen.getByText(message, { exact: true })).toBeVisible();
    expect(mocks.dismiss).not.toHaveBeenCalled();
    opened.resolve(viewer("/viewer", "registered-guest"));
    await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
    expect(mocks.dismiss).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { name: "registered-guest" },
    });
  },
);

it("renews a lease before it expires, on the client clock, and keeps renewing while hidden", async () => {
  setup();
  const threadRef = threadRefFor("expiry");
  mocks.state = { ...state, sessions: [{ name: "selected-mac", threadId: threadRef.threadId }] };
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  const opened = pendingViewer();
  mocks.open.mockReturnValue(opened.promise);
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  using _timers = fakeTimers();
  // A client clock far behind the server's must not matter.
  vi.setSystemTime(0);
  await act(async () => {
    opened.resolve(viewer("/viewer"));
    await opened.promise;
  });
  mocks.open.mockResolvedValue(viewer("/renewed"));
  await act(() => vi.advanceTimersByTimeAsync(3_299_999));
  expect(mocks.open).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(mocks.open).toHaveBeenCalledTimes(2);
  expect(iframe(screen)?.getAttribute("src")).toContain("/renewed");
  await screen.rerender(<ActiveTab threadRef={threadRef} visible={false} />);
  expect(iframe(screen)?.getAttribute("src")).toContain("/renewed");
  mocks.open.mockResolvedValue(viewer("/renewed-hidden"));
  await act(() => vi.advanceTimersByTimeAsync(3_300_000));
  expect(mocks.open).toHaveBeenCalledTimes(3);
  expect(iframe(screen)?.getAttribute("src")).toContain("/renewed-hidden");
});

/** Renders the thread's VM tabs the way the right panel does. */
function PanelTabs({ threadRef }: { threadRef: ScopedThreadRef }) {
  const surfaces = useRightPanelStore(
    (store) => selectThreadRightPanelState(store.byThreadKey, threadRef).surfaces,
  );
  const activeSurfaceId = useRightPanelStore(
    (store) => selectThreadRightPanelState(store.byThreadKey, threadRef).activeSurfaceId,
  );
  return (
    <VirtualMachineTabs
      threadRef={threadRef}
      surfaces={surfaces}
      activeSurfaceId={activeSurfaceId}
      visible
    />
  );
}

it("keeps each VM tab's desktop connected across tab switches and tab moves", async () => {
  setup();
  const threadRef = threadRefFor("tab-switch");
  mocks.state = {
    ...state,
    machines: [
      { name: "selected-mac", status: "running" },
      { name: "other-mac", status: "running" },
    ],
  };
  mocks.open.mockImplementation(({ input }: { input: { name: string } }) =>
    Promise.resolve(viewer(`/viewer-${input.name}`, input.name)),
  );
  const panels = useRightPanelStore.getState();
  panels.openVirtualMachine(threadRef, "selected-mac");
  await using screen = await render(<PanelTabs threadRef={threadRef} />);
  const desktop = (name: string) =>
    screen.container.querySelector<HTMLIFrameElement>(`iframe[src*="/viewer-${name}"]`);
  await vi.waitFor(() => expect(desktop("selected-mac")).not.toBeNull());
  const selectedId = selectActiveRightPanelSurface(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  )!.id;
  // A moved or remounted iframe gets a new window and reconnects its stream.
  const selectedWindow = desktop("selected-mac")!.contentWindow;

  panels.openVirtualMachine(threadRef, "other-mac");
  await vi.waitFor(() => expect(desktop("other-mac")).not.toBeNull());
  const otherWindow = desktop("other-mac")!.contentWindow;
  expect(desktop("selected-mac")!.checkVisibility()).toBe(false);

  panels.moveSurface(threadRef, selectedId, 1);
  panels.activateSurface(threadRef, selectedId);
  await vi.waitFor(() => expect(desktop("selected-mac")!.checkVisibility()).toBe(true));
  expect(desktop("other-mac")!.checkVisibility()).toBe(false);
  expect(desktop("selected-mac")!.contentWindow).toBe(selectedWindow);
  expect(desktop("other-mac")!.contentWindow).toBe(otherWindow);
  expect(mocks.open).toHaveBeenCalledTimes(2);
});

it("does not reopen automatically after a requested open fails and publishes its session", async () => {
  setup();
  const threadRef = threadRefFor("single-open");
  mocks.state = { ...state, machines: [{ name: "selected-mac", status: "running" }] };
  const opened = pendingViewer();
  mocks.open.mockReturnValueOnce(opened.promise);
  mocks.open.mockResolvedValue({ _tag: "Failure", cause: {} });
  requestVirtualMachineOpen(threadRef, "selected-mac");
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await act(() =>
    publishState({
      sessions: [{ name: "selected-mac", threadId: threadRef.threadId }],
    }),
  );
  await act(async () => {
    opened.resolve({ _tag: "Failure", cause: {} });
    await opened.promise;
  });
  expect(mocks.open).toHaveBeenCalledTimes(1);
  await screen.getByRole("button", { name: "Suspend selected-mac", exact: true }).click();
  expect(mocks.stop).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { name: "selected-mac" },
  });
  await expect.element(screen.getByText("device list")).toBeVisible();
});

it("keeps a failed viewer reconnect in the same bounded recovery attempt", async () => {
  setup();
  const threadRef = threadRefFor("reconnect");
  mocks.state = { ...state, sessions: [{ name: "selected-mac", threadId: threadRef.threadId }] };
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  mocks.open
    .mockResolvedValueOnce(viewer("/viewer"))
    .mockResolvedValue({ _tag: "Failure", cause: {} });
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  const frame = iframe(screen);
  await screen.getByRole("button", { name: "More VM actions", exact: true }).click();
  const reconnect = screen.getByRole("menuitem", { name: "Reconnect VM viewer" });
  await expect.element(reconnect).toBeVisible();
  using _timers = fakeTimers();
  await reconnect.click();
  for (let retry = 0; retry < 3; retry++) {
    await act(() => vi.advanceTimersByTimeAsync(2_000));
  }
  expect(mocks.open).toHaveBeenCalledTimes(5);
  expect(iframe(screen)).toBe(frame);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(mocks.open).toHaveBeenCalledTimes(5);
  await expect
    .element(screen.getByRole("button", { name: "Retry connection", exact: true }))
    .toBeVisible();
});

it("discards an open reply that arrives after switching environments", async () => {
  setup();
  const threadRef = threadRefFor("stale");
  const otherRef = { ...threadRef, environmentId: EnvironmentId.make("stale-other-env") };
  mocks.state = { ...state, machines: [{ name: "selected-mac", status: "running" }] };
  const opened = pendingViewer();
  mocks.open.mockReturnValueOnce(opened.promise);
  requestVirtualMachineOpen(threadRef, "selected-mac");
  for (const ref of [threadRef, otherRef])
    useRightPanelStore.getState().openVirtualMachine(ref, "selected-mac");
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  expect(mocks.open).toHaveBeenCalledTimes(1);
  mocks.open.mockReturnValue(new Promise(() => {}));
  await screen.rerender(<ActiveTab threadRef={otherRef} />);
  await act(async () => {
    opened.resolve(viewer("/wrong-environment"));
    await opened.promise;
  });
  expect(iframe(screen)).toBeNull();
});

it("restores a running VM after server sessions are lost on restart", async () => {
  setup();
  const threadRef = threadRefFor("restart");
  mocks.state = {
    ...state,
    machines: [{ name: "selected-mac", status: "running" }],
    sessions: [{ name: "selected-mac", threadId: threadRef.threadId }],
  };
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  mocks.open.mockResolvedValue(viewer("/viewer"));
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  await screen.rerender(<div>Other tab</div>);
  await act(() => publishState({ machines: [], sessions: [] }));
  const discovered = { ...state, machines: [{ name: "selected-mac", status: "running" }] };
  let finishDiscovery!: (result: { _tag: "Success"; value: VirtualMachineState }) => void;
  const discovery = new Promise<{ _tag: "Success"; value: VirtualMachineState }>((resolve) => {
    finishDiscovery = resolve;
  });
  mocks.list.mockReturnValue(discovery);
  await screen.rerender(<ActiveTab threadRef={threadRef} />);
  await expect.element(screen.getByText("device list", { exact: true })).not.toBeInTheDocument();
  expect(mocks.open).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishDiscovery({ _tag: "Success", value: discovered });
    await discovery;
  });
  await expect.element(screen.getByText("device list", { exact: true })).not.toBeInTheDocument();
  await act(() => publishState(discovered));
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  expect(mocks.open).toHaveBeenCalledTimes(2);
  await screen.rerender(<div>Other tab</div>);
  await act(() => publishState({ machines: [], sessions: [] }));
  mocks.list.mockResolvedValue({ _tag: "Success", value: state });
  await screen.rerender(<ActiveTab threadRef={threadRef} />);
  await expect.element(screen.getByText("device list", { exact: true })).toBeVisible();
  expect(mocks.open).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "does not restart a suspended VM with a retained session: %s",
  async (retainedSession) => {
    setup();
    const threadRef = threadRefFor(`suspended-${retainedSession}`);
    mocks.state = {
      ...state,
      machines: [{ name: "selected-mac", status: "stopped" }],
      sessions: retainedSession ? [{ name: "selected-mac", threadId: threadRef.threadId }] : [],
    };
    useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
    await using screen = await render(<ActiveTab threadRef={threadRef} />);
    await expect.element(screen.getByText("device list")).toBeVisible();
    expect(mocks.open).not.toHaveBeenCalled();
  },
);

it("keeps an externally closed session closed across remounts and permits an explicit reopen", async () => {
  setup();
  const threadRef = threadRefFor("external-close");
  mocks.state = {
    ...state,
    machines: [{ name: "selected-mac", status: "running" }],
    sessions: [{ name: "selected-mac", threadId: threadRef.threadId }],
  };
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  mocks.open.mockResolvedValue(viewer("/viewer"));
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  await act(() =>
    publishState({
      sessions: [],
      closedSessions: [{ name: "selected-mac", threadId: threadRef.threadId, id: "close-1" }],
    }),
  );
  await expect.element(screen.getByText("device list")).toBeVisible();
  // A later remount of the same VM's tab, as after a reload, stays closed.
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  await screen.rerender(<ActiveTab threadRef={threadRef} />);
  await expect.element(screen.getByText("device list")).toBeVisible();
  expect(mocks.open).toHaveBeenCalledTimes(1);
  requestVirtualMachineOpen(threadRef, "selected-mac");
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  await screen.rerender(<ActiveTab threadRef={threadRef} />);
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  expect(mocks.open).toHaveBeenCalledTimes(2);
  await act(() =>
    publishState({
      closedSessions: [{ name: "selected-mac", threadId: threadRef.threadId, id: "close-2" }],
    }),
  );
  await expect.element(screen.getByText("device list")).toBeVisible();
});

it("reopens the VM when its closed tab is restored", async () => {
  setup();
  const threadRef = threadRefFor("restore-tab");
  mocks.state = {
    ...state,
    machines: [{ name: "mac-one", status: "running" }],
    closedSessions: [{ name: "mac-one", threadId: threadRef.threadId, id: "tab-close" }],
  };
  mocks.open.mockResolvedValue(viewer("/viewer", "mac-one"));
  await reopenClosedView(
    {
      kind: "panel-tab",
      threadRef,
      surface: { id: "device:@vm:mac-one", kind: "device", virtualMachine: "mac-one" },
    },
    {
      workspaceAvailable: true,
      openPreview: () => {
        throw new Error("A VM tab must not open a browser");
      },
    },
  );
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  expect(mocks.open).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { name: "mac-one", threadId: threadRef.threadId },
  });
});

it("returns the environment's VM tabs to the device list when VM support is turned off", async () => {
  setup();
  const threadRef = threadRefFor("disable");
  const otherThread = { ...threadRef, threadId: ThreadId.make("disable-other") };
  mocks.state = {
    ...state,
    machines: [{ name: "selected-mac", status: "running" }],
    sessions: [{ name: "selected-mac", threadId: threadRef.threadId }],
  };
  for (const ref of [threadRef, otherThread])
    useRightPanelStore.getState().openVirtualMachine(ref, "selected-mac");
  mocks.open.mockResolvedValue(viewer("/viewer"));
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  await act(() => publishState({ enabled: false }));
  await expect.element(screen.getByText("device list")).toBeVisible();
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, otherThread),
  ).toEqual({ id: "device", kind: "device" });
});

it("floats the VM over chat, keeping control, and closes it there when the session ends", async () => {
  setup();
  const threadRef = threadRefFor("float");
  mocks.state = {
    ...state,
    machines: [{ name: "selected-mac", status: "running" }],
    sessions: [{ name: "selected-mac", threadId: threadRef.threadId }],
  };
  mocks.open.mockResolvedValue(viewer("/viewer"));
  useRightPanelStore.getState().openVirtualMachine(threadRef, "selected-mac");
  await using screen = await render(<ActiveTab threadRef={threadRef} />);
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  await screen.getByRole("button", { name: "More VM actions", exact: true }).click();
  await screen.getByRole("menuitem", { name: "Float VM over chat" }).click();
  expect(
    usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.source,
  ).toEqual({ kind: "vm", name: "selected-mac" });
  expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.isOpen).toBe(false);

  await screen.rerender(
    <VirtualMachineDeviceView
      threadRef={threadRef}
      placement={{ kind: "floating" }}
      name="selected-mac"
      visible
    />,
  );
  await vi.waitFor(() => expect(iframe(screen)).not.toBeNull());
  await act(() =>
    publishState({
      sessions: [],
      closedSessions: [{ name: "selected-mac", threadId: threadRef.threadId, id: "agent-close" }],
    }),
  );
  expect(
    usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(threadRef)],
  ).toBeUndefined();
  expect(mocks.close).not.toHaveBeenCalled();
});

it.each(["suspension", "closing the view"])(
  "discards a pending viewer after %s",
  async (reason) => {
    setup();
    const threadRef = threadRefFor(`pending-${reason.replace(" ", "-")}`);
    mocks.state = { ...state, machines: [{ name: "mac-one", status: "running" }] };
    const opened = pendingViewer();
    mocks.open.mockReturnValue(opened.promise);
    requestVirtualMachineOpen(threadRef, "mac-one");
    useRightPanelStore.getState().openVirtualMachine(threadRef, "mac-one");
    await using screen = await render(<ActiveTab threadRef={threadRef} />);
    if (reason === "suspension")
      await act(() =>
        useRightPanelStore.getState().releaseVirtualMachineTabs(threadRef.environmentId, "mac-one"),
      );
    else await screen.getByRole("button", { name: "Close view", exact: true }).click();
    const expected = reason === "suspension" ? "device list" : "no device tab";
    await expect.element(screen.getByText(expected)).toBeVisible();
    await act(async () => {
      opened.resolve(viewer("/stale", "mac-one"));
      await opened.promise;
    });
    expect(iframe(screen)).toBeNull();
    await expect.element(screen.getByText(expected)).toBeVisible();
  },
);
