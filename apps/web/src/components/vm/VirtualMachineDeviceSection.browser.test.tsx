import { EnvironmentId, ThreadId, type VirtualMachineState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { VirtualMachineDeviceSection, VirtualMachineSetup } from "./VirtualMachineDeviceSection";
import { takeVirtualMachineOpen } from "./virtualMachinePanelSession";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  configure: vi.fn(),
  canConfigure: true,
  state: undefined as VirtualMachineState | undefined,
}));
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
    permissionAtom: () => (label === "configure" && !mocks.canConfigure ? denied : permission),
  });
  return {
    useVirtualMachinesSupported: () => true,
    virtualMachineEnvironment: {
      state: () => null,
      list: command("list"),
      configure: command("configure"),
      create: command("create"),
      open: command("open"),
      stop: command("stop"),
      remove: command("remove"),
      dismiss: command("dismiss"),
    },
  };
});
vi.mock("~/state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/query")>()),
  useEnvironmentQuery: () => ({ data: mocks.state, error: null, refresh: () => {} }),
  formatEnvironmentQueryError: () => "VM command failed",
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => (input: unknown) => {
    if (command.label === "list") return mocks.list(input);
    if (command.label === "create") return mocks.create(input);
    if (command.label === "configure") return mocks.configure(input);
    return Promise.resolve({ _tag: "Success", value: {} });
  },
}));

const threadRef = {
  environmentId: EnvironmentId.make("vm-section-env"),
  threadId: ThreadId.make("vm-section-thread"),
};

function setup(next: Partial<VirtualMachineState> = {}) {
  useRightPanelStore.setState({ byThreadKey: {} });
  mocks.canConfigure = true;
  mocks.state = { ...state, ...next };
  mocks.list.mockReset().mockResolvedValue({ _tag: "Success", value: state });
  mocks.create.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  mocks.configure.mockReset().mockResolvedValue({ _tag: "Success", value: state });
}

it("blocks an existing VM name before creation even when the form is submitted directly", async () => {
  setup({ machines: [{ name: "native-tile", status: "stopped" }] });
  await using screen = await render(<VirtualMachineDeviceSection threadRef={threadRef} />);
  await screen.getByRole("button", { name: "Create VM", exact: true }).click();
  await page.getByRole("textbox", { name: "Virtual machine name" }).fill("native-tile");
  await expect.element(page.getByRole("button", { name: "Create VM", exact: true })).toBeDisabled();
  await act(() => document.querySelector("form")!.requestSubmit());
  expect(mocks.create).not.toHaveBeenCalled();
  await page.getByRole("textbox", { name: "Virtual machine name" }).fill("another-mac");
  await expect.element(page.getByRole("button", { name: "Create VM", exact: true })).toBeEnabled();
});

it("shows one VM while creation finishes, then replaces its progress with Open", async () => {
  setup({
    machines: [{ name: "native-tile-tests", status: "running" }],
    operations: [{ name: "native-tile-tests", status: "creating", error: null }],
  });
  await using screen = await render(<VirtualMachineDeviceSection threadRef={threadRef} />);
  await expect.element(screen.getByText("Preparing desktop and input…")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Open native-tile-tests", exact: true }))
    .not.toBeInTheDocument();
  mocks.state = { ...mocks.state!, operations: [] };
  await screen.rerender(<VirtualMachineDeviceSection threadRef={{ ...threadRef }} />);
  await expect
    .element(screen.getByRole("button", { name: "Open native-tile-tests", exact: true }))
    .toBeVisible();
});

it("retries creation with the same name when no guest was registered", async () => {
  setup({
    operations: [{ name: "missing-guest", status: "failed", error: "Image download failed" }],
  });
  await using screen = await render(<VirtualMachineDeviceSection threadRef={threadRef} />);
  await userEvent.click(screen.getByRole("button", { name: "Retry setup", exact: true }));
  await expect
    .element(page.getByRole("textbox", { name: "Virtual machine name" }))
    .toHaveValue("missing-guest");
});

it("opens a VM from the list in its own device tab and asks that tab to start it", async () => {
  setup({ machines: [{ name: "stopped-mac", status: "stopped" }] });
  useRightPanelStore.getState().open(threadRef, "device");
  await using screen = await render(<VirtualMachineDeviceSection threadRef={threadRef} />);
  await screen.getByRole("button", { name: "Start stopped-mac", exact: true }).click();
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toEqual({ id: "device:@vm:stopped-mac", kind: "device", virtualMachine: "stopped-mac" });
  expect(takeVirtualMachineOpen(threadRef, "stopped-mac")).toBe(true);
});

it("turns VM support on from the device list", async () => {
  setup({ enabled: false });
  await using screen = await render(<VirtualMachineDeviceSection threadRef={threadRef} />);
  await screen.getByRole("button", { name: "Turn on", exact: true }).click();
  expect(mocks.configure).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { enabled: true },
  });
});

it("discovers saved VM support during setup and retries a failed initial probe", async () => {
  setup({ available: false, unavailableReason: null });
  mocks.canConfigure = false;
  let failDiscovery!: (result: { _tag: "Failure"; cause: object }) => void;
  const discovery = new Promise<{ _tag: "Failure"; cause: object }>((resolve) => {
    failDiscovery = resolve;
  });
  mocks.list.mockReturnValueOnce(discovery);
  await using screen = await render(
    <VirtualMachineSetup environmentId={threadRef.environmentId} />,
  );
  await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  await expect.element(screen.getByText("Checking Lume and Cua…")).toBeVisible();
  await expect.element(screen.getByText("Lume is not available yet.")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("switch", { name: "Use macOS virtual machines" }))
    .toBeDisabled();
  await act(async () => {
    failDiscovery({ _tag: "Failure", cause: {} });
    await discovery;
  });
  await expect.element(screen.getByRole("alert")).toHaveTextContent("VM command failed");
  mocks.list.mockImplementationOnce(() => {
    mocks.state = state;
    return Promise.resolve({ _tag: "Success", value: state });
  });
  await screen.getByRole("button", { name: "Retry VM discovery" }).click();
  await expect
    .element(screen.getByText("Lume and Cua are available.", { exact: false }))
    .toBeVisible();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(mocks.configure).not.toHaveBeenCalled();
});
