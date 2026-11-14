import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type VirtualMachineState } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ open: vi.fn(), list: vi.fn(), uri: "" }));
const generation = Atom.family((_id: EnvironmentId) => Atom.make(0));
const permitted = Atom.family((_id: EnvironmentId | null) => Atom.make(false));
const supported = Atom.family((_id: EnvironmentId | null) => Atom.make(false));
const initialState: VirtualMachineState = {
  enabled: true,
  available: false,
  unavailableReason: null,
  machines: [],
  sessions: [],
  operations: [],
};
const state = Atom.family((_id: EnvironmentId) => Atom.make(AsyncResult.success(initialState)));

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
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: (id: EnvironmentId | null) => ({
    environment: { capabilities: { virtualMachines: useAtomValue(supported(id)) } },
  }),
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  environmentSessionGenerationAtom: (_runtime: unknown, id: EnvironmentId) => generation(id),
}));
vi.mock("@t3tools/client-runtime/state/virtual-machines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/virtual-machines")>()),
  createVirtualMachineEnvironmentAtoms: () => ({
    open: { label: "open" },
    list: {
      label: "list",
      run: mocks.list,
      permissionAtom: (id: EnvironmentId | null) => permitted(id),
    },
    state: ({ environmentId }: { environmentId: EnvironmentId }) => state(environmentId),
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.open }));

import { VirtualMachinePreview } from "./VirtualMachinePreview";
import { useVirtualMachineState } from "../../state/virtualMachines";

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

it("discovers cold mobile inventories once per permitted session and ignores old environment replies", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const first = EnvironmentId.make("first-vm-environment");
  const second = EnvironmentId.make("second-vm-environment");
  const pending = new Map<
    EnvironmentId,
    ReturnType<typeof Promise.withResolvers<AsyncResult.Success<VirtualMachineState>>>
  >();
  mocks.list
    .mockReset()
    .mockImplementation((_registry: unknown, target: { environmentId: EnvironmentId }) => {
      const request = Promise.withResolvers<AsyncResult.Success<VirtualMachineState>>();
      pending.set(target.environmentId, request);
      return request.promise;
    });
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  function Probe({ environmentId }: { environmentId: EnvironmentId | null }) {
    const result = useVirtualMachineState(environmentId);
    return (
      <span>{result.data?.machines.map((machine) => machine.name).join(",") ?? "unsupported"}</span>
    );
  }
  const render = (environmentId: EnvironmentId | null) =>
    act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe environmentId={environmentId} />
          <Probe environmentId={environmentId} />
        </RegistryContext.Provider>,
      );
    });
  await render(first);
  expect(mocks.list).not.toHaveBeenCalled();
  await act(async () => registry.set(supported(first), true));
  await act(async () => registry.set(permitted(first), true));
  expect(mocks.list).not.toHaveBeenCalled();
  await act(async () => registry.set(generation(first), 1));
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith(registry, { environmentId: first, input: {} });
  const firstRequest = pending.get(first)!;
  const discovered: VirtualMachineState = {
    ...initialState,
    available: true,
    machines: [{ name: "first-mac", status: "stopped" }],
  };
  await act(async () => {
    registry.set(state(first), AsyncResult.success(discovered));
    firstRequest.resolve(AsyncResult.success(discovered));
  });
  expect(container.textContent).toBe("first-macfirst-mac");
  await render(first);
  expect(mocks.list).toHaveBeenCalledTimes(1);
  await act(async () => registry.set(generation(first), 2));
  expect(mocks.list).toHaveBeenCalledTimes(2);
  const stale = pending.get(first)!;
  registry.set(supported(second), true);
  registry.set(permitted(second), true);
  registry.set(generation(second), 1);
  await render(second);
  expect(mocks.list).toHaveBeenCalledTimes(3);
  expect(mocks.list).toHaveBeenLastCalledWith(registry, { environmentId: second, input: {} });
  await act(async () => stale.resolve(AsyncResult.success(discovered)));
  expect(container.textContent).toBe("");
  const otherState: VirtualMachineState = {
    ...discovered,
    machines: [{ name: "second-mac", status: "running" }],
  };
  await act(async () => {
    registry.set(state(second), AsyncResult.success(otherState));
    pending.get(second)!.resolve(AsyncResult.success(otherState));
  });
  expect(container.textContent).toBe("second-macsecond-mac");
  await act(async () => registry.set(permitted(second), false));
  await act(async () => registry.set(generation(second), 2));
  expect(mocks.list).toHaveBeenCalledTimes(3);
  await act(async () => registry.set(permitted(second), true));
  expect(mocks.list).toHaveBeenCalledTimes(4);
  await act(async () => pending.get(second)!.resolve(AsyncResult.success(otherState)));
  await render(null);
  expect(container.textContent).toBe("unsupportedunsupported");
  expect(mocks.list).toHaveBeenCalledTimes(4);
});
