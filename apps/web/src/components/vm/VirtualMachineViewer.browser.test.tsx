import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import { VirtualMachineViewer, type VirtualMachineViewerControls } from "./VirtualMachineViewer";

function viewerProps() {
  return {
    url: "about:blank",
    name: "Test Mac",
    onReconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onClose: vi.fn(),
    onScreen: vi.fn(),
    // Stands in for the rail a device tab draws.
    renderControls: (controls: VirtualMachineViewerControls) => (
      <button type="button" disabled={controls.reconnecting} onClick={controls.reconnect}>
        {controls.reconnecting ? "Reconnecting VM viewer" : "Reconnect VM viewer"}
      </button>
    ),
  };
}

async function message(source: Window | null, data: unknown) {
  await act(() => {
    window.dispatchEvent(new MessageEvent("message", { source, data }));
  });
}

function status(source: Window | null, status: string) {
  return message(source, { type: "t3-vm-viewer-status", status });
}

async function advance(milliseconds: number) {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

it("keeps startup failures covered until the current guest reports streaming", async () => {
  await using screen = await render(<VirtualMachineViewer {...viewerProps()} />);
  expect(screen.container.querySelector("iframe")!.allow).not.toContain("clipboard");
  const source = screen.container.querySelector("iframe")!.contentWindow;
  expect(screen.container.querySelector("iframe")!.inert).toBe(true);
  await status(window, "streaming");
  await message(source, null);
  await message(source, { type: "other", status: "streaming" });
  await status(source, "unknown");
  await expect.element(screen.getByRole("status", { name: "", exact: true })).toBeVisible();
  await status(source, "failed");
  await expect
    .element(screen.getByText("Connecting to desktop and preparing input…"))
    .toBeVisible();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  await status(source, "streaming");
  expect(screen.container.querySelector("iframe")!.inert).toBe(false);
  expect(screen.container.querySelector('[role="status"]')).toBeNull();
  screen.container.querySelector("iframe")!.focus();
  await status(source, "reconnecting");
  expect(screen.container.querySelector("iframe")!.inert).toBe(true);
  expect(document.activeElement).not.toBe(screen.container.querySelector("iframe"));
  await expect.element(screen.getByText("Reconnecting to desktop…")).toBeVisible();
});

it("shows recovery after 45 seconds despite repeated or changing guest messages", async () => {
  await using screen = await render(<VirtualMachineViewer {...viewerProps()} />);
  using _timers = fakeTimers();
  await screen.getByRole("button", { name: "Reconnect VM viewer", exact: true }).click();
  const source = screen.container.querySelector("iframe")!.contentWindow;
  await advance(20_000);
  await status(source, "reconnecting");
  await advance(20_000);
  await status(source, "connecting");
  await advance(5_000);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await status(source, "failed");
  await status(source, "connecting");
  await expect
    .element(screen.getByRole("button", { name: "Retry connection", exact: true }))
    .toBeVisible();
  const retry = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry connection",
  )!;
  retry.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.container.querySelector("div[tabindex='-1']"));
  await status(source, "streaming");
  expect(document.activeElement).toBe(screen.container.querySelector("iframe"));
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  const outside = document.createElement("button");
  document.body.append(outside);
  using _outside = { [Symbol.dispose]: () => outside.remove() };
  outside.focus();
  await status(source, "reconnecting");
  await status(source, "streaming");
  expect(document.activeElement).toBe(outside);
});

it("bounds automatic retries and resets recovery when the user retries", async () => {
  const props = viewerProps();
  await using screen = await render(<VirtualMachineViewer {...props} />);
  using _timers = fakeTimers();
  await screen.getByRole("button", { name: "Reconnect VM viewer", exact: true }).click();
  props.onReconnect.mockClear();
  const source = screen.container.querySelector("iframe")!.contentWindow;
  await status(source, "failed");
  await advance(1_999);
  expect(props.onReconnect).not.toHaveBeenCalled();
  await advance(1);
  expect(props.onReconnect).toHaveBeenCalledTimes(1);
  await advance(2_000);
  await advance(2_000);
  expect(props.onReconnect).toHaveBeenCalledTimes(3);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Retry connection", exact: true }))
    .toBeVisible();
  await advance(39_000);
  await status(source, "failed");
  await advance(10_000);
  expect(props.onReconnect).toHaveBeenCalledTimes(3);
  await screen.getByRole("button", { name: "Retry connection", exact: true }).click();
  expect(props.onReconnect).toHaveBeenCalledTimes(4);
  await expect.element(screen.getByRole("status", { name: "", exact: true })).toBeVisible();
  await status(source, "failed");
  await advance(2_000);
  expect(props.onReconnect).toHaveBeenCalledTimes(5);
  await status(source, "streaming");
  await advance(60_000);
  expect(props.onReconnect).toHaveBeenCalledTimes(5);
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
});

it("preserves the retry limit and recovery deadline across renewed viewer leases", async () => {
  const props = viewerProps();
  await using screen = await render(<VirtualMachineViewer {...props} />);
  using _timers = fakeTimers();
  await screen.getByRole("button", { name: "Reconnect VM viewer", exact: true }).click();
  props.onReconnect.mockClear();
  for (let lease = 1; lease <= 3; lease++) {
    await advance(10_000);
    const oldSource = screen.container.querySelector("iframe")!.contentWindow;
    await status(oldSource, "failed");
    await advance(2_000);
    expect(props.onReconnect).toHaveBeenCalledTimes(lease);
    await screen.rerender(<VirtualMachineViewer {...props} url={`about:blank#lease-${lease}`} />);
    expect(screen.container.querySelector("iframe")!.contentWindow === oldSource).toBe(false);
    await status(oldSource, "streaming");
    await expect.element(screen.getByRole("status", { name: "", exact: true })).toBeVisible();
  }
  const source = screen.container.querySelector("iframe")!.contentWindow;
  await status(source, "failed");
  await advance(8_999);
  expect(props.onReconnect).toHaveBeenCalledTimes(3);
  expect(props.onClose).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await advance(1);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await screen.rerender(<VirtualMachineViewer {...props} url="about:blank#another-lease" />);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await screen.getByRole("button", { name: "Retry connection", exact: true }).click();
  await screen.rerender(<VirtualMachineViewer {...props} url="about:blank#manual-lease" />);
  await status(screen.container.querySelector("iframe")!.contentWindow, "failed");
  await advance(2_000);
  expect(props.onReconnect).toHaveBeenCalledTimes(5);
  await expect.element(screen.getByRole("status", { name: "", exact: true })).toBeVisible();
  await advance(43_000);
  await expect.element(screen.getByRole("alert")).toBeVisible();
});

it("ignores retired frames and resets recovery when the VM changes", async () => {
  const props = viewerProps();
  await using screen = await render(<VirtualMachineViewer {...props} />);
  using _timers = fakeTimers();
  await screen.getByRole("button", { name: "Reconnect VM viewer", exact: true }).click();
  props.onReconnect.mockClear();
  const oldSource = screen.container.querySelector("iframe")!.contentWindow;
  await status(oldSource, "failed");
  await screen.rerender(<VirtualMachineViewer {...props} url="about:blank#next" />);
  const newSource = screen.container.querySelector("iframe")!.contentWindow;
  await status(oldSource, "streaming");
  await advance(2_000);
  expect(props.onReconnect).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("status", { name: "", exact: true })).toBeVisible();
  await status(newSource, "failed");
  await advance(2_000);
  expect(props.onReconnect).toHaveBeenCalledTimes(1);
  await advance(41_000);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await screen.rerender(
    <VirtualMachineViewer {...props} name="Another Mac" url="about:blank#third" />,
  );
  await expect.element(screen.getByRole("status", { name: "", exact: true })).toBeVisible();
});

it("reports the desktop size only from the current frame", async () => {
  const props = viewerProps();
  await using screen = await render(<VirtualMachineViewer {...props} />);
  const source = screen.container.querySelector("iframe")!.contentWindow;
  await message(window, { type: "t3-vm-viewer-size", width: 1024, height: 768 });
  await message(source, { type: "t3-vm-viewer-size", width: 0, height: 768 });
  await message(source, { type: "t3-vm-viewer-size", width: "1024", height: 768 });
  expect(props.onScreen).not.toHaveBeenCalled();
  await message(source, { type: "t3-vm-viewer-size", width: 1440, height: 900 });
  expect(props.onScreen).toHaveBeenCalledExactlyOnceWith({ width: 1440, height: 900 });
});

it("cancels pending automatic retries when unmounted", async () => {
  const props = viewerProps();
  await using screen = await render(<VirtualMachineViewer {...props} />);
  using _timers = fakeTimers();
  const source = screen.container.querySelector("iframe")!.contentWindow;
  await status(source, "failed");
  await screen.unmount();
  await advance(60_000);
  expect(props.onReconnect).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("keeps rejected reconnects recoverable and resets the budget after streaming", async () => {
  const props = viewerProps();
  props.onReconnect.mockRejectedValue(new Error("Unavailable"));
  await using screen = await render(<VirtualMachineViewer {...props} />);
  using _timers = fakeTimers();
  await screen.getByRole("button", { name: "Reconnect VM viewer", exact: true }).click();
  const source = screen.container.querySelector("iframe")!.contentWindow;
  await advance(2_000);
  await advance(2_000);
  await advance(2_000);
  expect(props.onReconnect).toHaveBeenCalledTimes(4);
  await advance(39_000);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await status(source, "streaming");
  await status(source, "failed");
  await advance(2_000);
  expect(props.onReconnect).toHaveBeenCalledTimes(5);
  await expect.element(screen.getByRole("status", { name: "", exact: true })).toBeVisible();
});

it("offers close after recovery expires", async () => {
  const props = viewerProps();
  await using screen = await render(<VirtualMachineViewer {...props} />);
  using _timers = fakeTimers();
  await screen.getByRole("button", { name: "Reconnect VM viewer", exact: true }).click();
  await advance(45_000);
  await screen.getByRole("button", { name: "Close view", exact: true }).click();
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("makes an outstanding reconnect explicit and keeps recovery disabled until it finishes", async () => {
  const props = viewerProps();
  let finish!: () => void;
  props.onReconnect.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await using screen = await render(<VirtualMachineViewer {...props} />);
  using _timers = fakeTimers();
  const source = screen.container.querySelector("iframe")!.contentWindow;
  await screen.getByRole("button", { name: "Reconnect VM viewer", exact: true }).click();
  await status(source, "failed");
  await advance(45_000);
  expect(props.onReconnect).toHaveBeenCalledTimes(1);
  await expect
    .element(screen.getByRole("button", { name: "Reconnecting…", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Reconnecting VM viewer", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Close view", exact: true }))
    .toBeVisible();
  await act(() => finish());
  await expect
    .element(screen.getByRole("button", { name: "Retry connection", exact: true }))
    .toBeEnabled();
  await advance(2_000);
  expect(props.onReconnect).toHaveBeenCalledTimes(1);
  await screen.getByRole("button", { name: "Retry connection", exact: true }).click();
  expect(props.onReconnect).toHaveBeenCalledTimes(2);
});
