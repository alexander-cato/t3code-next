import { EnvironmentId, ThreadId, type DeviceServiceState } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ThreadPreviewState } from "../../previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  pending: true,
  enabled: false,
  deviceStateLoaded: true,
  onboardingCompleted: true,
  openSetup: vi.fn(),
}));

vi.mock("~/state/virtualMachines", () => ({
  useVirtualMachinesSupported: () => true,
  virtualMachineEnvironment: { state: () => null },
}));
vi.mock("~/state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/query")>()),
  useEnvironmentQuery: () =>
    mocks.pending
      ? { data: null, isPending: true, isSuccess: false, error: null }
      : { data: { enabled: mocks.enabled }, isPending: false, isSuccess: true, error: null },
}));
vi.mock("./ChatOverlayHosts", () => ({
  openDeviceSetupDialog: mocks.openSetup,
}));

import { useRightPanelActions } from "./useRightPanelActions";

const threadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-1"),
};
function deviceStateForHarness(): DeviceServiceState {
  return {
    hosts: [],
    hostStatus: "disabled",
    hostStatuses: {},
    devices: [],
    sessions: [],
    onboardingCompleted: mocks.onboardingCompleted,
    agentAccessEnabled: false,
    hubBasePath: "/api/device-hub",
    revision: mocks.deviceStateLoaded ? 1 : 0,
  };
}
const previewState = {
  snapshot: null,
  sessions: {},
  suppressedTabIds: new Set<string>(),
  activeTabId: null,
  desktopOverlay: null,
  desktopByTabId: {},
  recentlySeenUrls: [],
  listLoaded: false,
  serverEpoch: null,
  serverRevision: 0,
} satisfies ThreadPreviewState;

function Harness() {
  const { addDeviceSurfaceStable } = useRightPanelActions({
    activeThreadRef: threadRef,
    activeProject: null,
    activeRightPanelSurface: null,
    activePreviewState: previewState,
    deviceState: deviceStateForHarness(),
    deviceStateLoaded: mocks.deviceStateLoaded,
    pullRequestPanelTarget: null,
    threadPanelPresentation: "inline",
    isServerThread: true,
    embedded: true,
    diffAvailable: false,
    browserAvailable: false,
    canOperatePreview: false,
    diffOpen: false,
    previewPanelOpen: false,
    rightPanelOpen: false,
    canMaximizeRightPanel: false,
    rightPanelMaximized: false,
    supportsPullRequests: false,
    pullRequestsSurfaceAvailable: false,
    gitCwd: null,
    activeProjectCwd: null,
    onDiffPanelOpen: undefined,
    closeRightPanelSurface: () => undefined,
  });
  return <button onClick={addDeviceSurfaceStable}>Devices</button>;
}

const devicePanel = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

const expectDevicePanelOpen = () => {
  const state = devicePanel();
  const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
  expect(state.isOpen).toBe(true);
  expect(active?.kind).toBe("device");
};

describe("addDeviceSurface before the VM snapshot", () => {
  it("opens the device panel instead of setup", async () => {
    mocks.pending = true;
    mocks.enabled = false;
    mocks.deviceStateLoaded = true;
    mocks.onboardingCompleted = true;
    mocks.openSetup.mockClear();
    useRightPanelStore.getState().close(threadRef);
    expect(devicePanel().isOpen).toBe(false);
    await using screen = await render(<Harness />);

    await userEvent.click(page.getByRole("button", { name: "Devices" }));

    expect(mocks.openSetup).not.toHaveBeenCalled();
    expectDevicePanelOpen();

    mocks.pending = false;
    mocks.enabled = true;
    await screen.rerender(<Harness />);
    await userEvent.click(page.getByRole("button", { name: "Devices" }));

    expect(mocks.openSetup).not.toHaveBeenCalled();
    expectDevicePanelOpen();
    useRightPanelStore.getState().close(threadRef);
  });

  it("opens the device panel while both snapshots are pending", async () => {
    mocks.pending = true;
    mocks.enabled = false;
    mocks.deviceStateLoaded = false;
    mocks.onboardingCompleted = false;
    mocks.openSetup.mockClear();
    useRightPanelStore.getState().close(threadRef);
    expect(devicePanel().isOpen).toBe(false);
    await using screen = await render(<Harness />);

    await userEvent.click(page.getByRole("button", { name: "Devices" }));

    expect(mocks.openSetup).not.toHaveBeenCalled();
    expectDevicePanelOpen();

    mocks.pending = false;
    mocks.enabled = true;
    mocks.deviceStateLoaded = true;
    mocks.onboardingCompleted = true;
    await screen.rerender(<Harness />);
    await userEvent.click(page.getByRole("button", { name: "Devices" }));

    expect(mocks.openSetup).not.toHaveBeenCalled();
    expectDevicePanelOpen();
    useRightPanelStore.getState().close(threadRef);
  });
});
