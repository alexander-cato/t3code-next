import type { DesktopInstallationDataState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { InstallationDataSettings } from "./InstallationDataSettings";

it("allows importing after returning from closing the source app", async () => {
  const state: DesktopInstallationDataState = {
    supported: true,
    installations: [{ directory: "/source", label: "T3 Code", running: true, origin: null }],
    backups: [],
  };
  const getState = vi.fn(async () => state);
  using _bridge = stubGlobal("desktopBridge", {
    getAppBranding: () => ({ baseName: "T3 Code Fork" }),
    getLocalEnvironmentEnabled: () => false,
    getLocalEnvironmentBootstraps: () => [],
    getInstallationDataState: getState,
    importInstallationData: vi.fn(),
    restoreInstallationData: vi.fn(),
  });
  await using screen = await render(<InstallationDataSettings onConnect={vi.fn()} />);

  const importButton = screen.getByRole("button", { name: "Import and restart" });
  await expect.element(importButton).toBeDisabled();
  getState.mockResolvedValue({
    ...state,
    installations: [{ ...state.installations[0]!, running: false }],
  });
  await act(() => window.dispatchEvent(new Event("focus")));
  await expect.element(importButton).toBeEnabled();

  let resolveOlder!: (value: DesktopInstallationDataState) => void;
  getState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOlder = resolve;
      }),
  );
  await act(() => window.dispatchEvent(new Event("focus")));
  await act(() => window.dispatchEvent(new Event("focus")));
  await act(() => resolveOlder(state));
  await expect.element(importButton).toBeEnabled();
});
