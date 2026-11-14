import { ThreadId, type VirtualMachineState } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { virtualMachinePreviewKey } from "./threadDevicePreviews";
import { threadDevicesMenuItems } from "./threadDevicesMenuItems";

const threadId = ThreadId.make("thread");
const virtualMachines: VirtualMachineState = {
  enabled: true,
  available: true,
  unavailableReason: null,
  machines: [
    { name: "open-mac", status: "ready" },
    { name: "stopped-mac", status: "stopped" },
    { name: "new-mac", status: "running" },
  ],
  sessions: [{ name: "open-mac", threadId }],
  operations: [{ name: "new-mac", status: "creating", error: null }],
};

it("lists the thread's open VM, then the VMs it can start, skipping ones still being created", () => {
  const items = threadDevicesMenuItems({
    threadId,
    devices: null,
    virtualMachines,
    canOpenVirtualMachines: false,
  });
  expect(items.map((item) => [item.title, item.disabled, item.deviceKey])).toEqual([
    ["open-mac", false, virtualMachinePreviewKey("open-mac")],
    ["Start stopped-mac", true, virtualMachinePreviewKey("stopped-mac")],
  ]);
  expect(
    threadDevicesMenuItems({
      threadId,
      devices: null,
      virtualMachines: { ...virtualMachines, enabled: false },
      canOpenVirtualMachines: true,
    }),
  ).toEqual([]);
});
