import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ open: vi.fn(), uri: "" }));

function Children({ children }: { readonly children?: ReactNode }) {
  return <>{children}</>;
}

vi.mock("react-native", () => ({
  View: Children,
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("react-native-webview", () => ({
  WebView: ({ source }: { source: { uri: string } }) => {
    mocks.uri = source.uri;
    return <div data-testid="vm-viewer" />;
  },
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {}, themeAppearance: "light" }),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <div role="progressbar" />,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  return { usePreparedConnection: () => Option.some({ httpBaseUrl: "https://vm.test" }) };
});
vi.mock("../../state/virtualMachines", () => ({
  virtualMachineEnvironment: { open: { label: "open" } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.open }));

import { VirtualMachinePreview } from "./VirtualMachinePreview";

it("opens the VM for its thread, expires the lease on the client clock, and reconnects", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  // A client clock far from the server's must not matter.
  vi.setSystemTime(0);
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  mocks.open
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { name: "mac-one", viewerPath: "/first/#ticket=a", expiresInMs: 15_000 },
    })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { name: "mac-one", viewerPath: "/second/#ticket=b", expiresInMs: 60_000 },
    });
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  await act(async () => {
    root.render(
      <VirtualMachinePreview
        environmentId={EnvironmentId.make("vm-env")}
        threadId={ThreadId.make("vm-thread")}
        name="mac-one"
      />,
    );
  });
  expect(mocks.open).toHaveBeenCalledWith({
    environmentId: "vm-env",
    input: { name: "mac-one", threadId: "vm-thread" },
  });
  expect(mocks.uri).toContain("/first/");
  // The stream view gives up on a desktop that never connects after 45 seconds.
  await act(async () => vi.advanceTimersByTimeAsync(14_999));
  expect(container.querySelector('[data-testid="vm-viewer"]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(container.textContent).toContain("The VM view expired. Reconnect to continue.");
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.open).toHaveBeenCalledTimes(2);
  expect(mocks.uri).toContain("/second/");
});
