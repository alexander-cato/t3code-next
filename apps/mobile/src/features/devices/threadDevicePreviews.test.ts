import { ThreadId, type DeviceServiceState, type VirtualMachineState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  selectedThreadDevicePreview,
  threadDevicePreviews,
  virtualMachinePreviewKey,
} from "./threadDevicePreviews";

const threadId = ThreadId.make("thread");
const state: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "Local",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
    {
      id: "remote",
      kind: "ssh",
      label: "Mac mini",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [
    {
      hostId: "local",
      id: "emulator-5554",
      platform: "android",
      name: "Pixel 9",
      version: "Android 16",
      booted: true,
      physical: false,
    },
    {
      hostId: "remote",
      id: "emulator-5554",
      platform: "android",
      name: "Pixel 8",
      version: "Android 15",
      booted: true,
      physical: false,
    },
  ],
  sessions: [
    {
      threadId,
      hostId: "local",
      deviceId: "emulator-5554",
      platform: "android",
      openedAt: "2026-09-18T00:00:00Z",
    },
    {
      threadId,
      hostId: "remote",
      deviceId: "emulator-5554",
      platform: "android",
      openedAt: "2026-09-18T00:01:00Z",
    },
    {
      threadId: ThreadId.make("another-thread"),
      hostId: "local",
      deviceId: "iphone",
      platform: "ios",
      openedAt: "2026-09-18T00:02:00Z",
    },
  ],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};

describe("thread device previews", () => {
  it("keeps device names and selection distinct when hosts have the same Android serial", () => {
    const previews = threadDevicePreviews(state, threadId);
    expect(previews.map((preview) => preview.name)).toEqual(["Pixel 9", "Pixel 8"]);
    expect(new Set(previews.map((preview) => preview.key)).size).toBe(2);
    expect(selectedThreadDevicePreview(previews, previews[1]!.key)?.description).toBe(
      "Android 15 · Mac mini",
    );
  });

  it("selects another open device when the agent closes the selected session", () => {
    const previews = threadDevicePreviews(state, threadId);
    const selectedKey = previews[1]!.key;
    const afterClose = threadDevicePreviews({ ...state, sessions: [state.sessions[0]!] }, threadId);
    expect(selectedThreadDevicePreview(afterClose, selectedKey)?.name).toBe("Pixel 9");
    expect(selectedThreadDevicePreview([], selectedKey)).toBeNull();
  });

  it("lists the thread's macOS VMs after its devices, with one the user asked to open", () => {
    const virtualMachines: VirtualMachineState = {
      enabled: true,
      available: true,
      unavailableReason: null,
      machines: [],
      sessions: [
        { name: "mac-one", threadId },
        { name: "other-thread-mac", threadId: ThreadId.make("another-thread") },
      ],
      operations: [],
    };
    const previews = threadDevicePreviews(state, threadId, virtualMachines, {
      name: "mac-two",
      closedSessionId: null,
    });
    expect(previews.map((preview) => [preview.kind, preview.name])).toEqual([
      ["device", "Pixel 9"],
      ["device", "Pixel 8"],
      ["vm", "mac-one"],
      ["vm", "mac-two"],
    ]);
    expect(previews.at(-1)?.key).toBe(virtualMachinePreviewKey("mac-two"));
    expect(
      threadDevicePreviews(
        state,
        threadId,
        { ...virtualMachines, enabled: false },
        { name: "mac-two", closedSessionId: null },
      ),
    ).toHaveLength(2);
    expect(
      threadDevicePreviews(
        null,
        threadId,
        {
          ...virtualMachines,
          machines: [{ name: "mac-two", status: "stopped" }],
          closedSessions: [{ name: "mac-two", threadId, id: "previous-close" }],
        },
        { name: "mac-two", closedSessionId: "previous-close" },
      ).map((preview) => preview.name),
    ).toEqual(["mac-one", "mac-two"]);
    expect(
      threadDevicePreviews(null, threadId, {
        ...virtualMachines,
        machines: [{ name: "mac-one", status: "stopped" }],
      }),
    ).toEqual([]);
  });

  it.each(["closed", "suspended"] as const)(
    "does not retain a requested VM after it is %s",
    (change) => {
      const virtualMachines: VirtualMachineState = {
        enabled: true,
        available: true,
        unavailableReason: null,
        machines: [{ name: "mac-one", status: change === "suspended" ? "stopped" : "ready" }],
        sessions: [],
        closedSessions: [{ name: "mac-one", threadId, id: "new-close" }],
        operations: [],
      };
      expect(
        threadDevicePreviews(null, threadId, virtualMachines, {
          name: "mac-one",
          closedSessionId: null,
        }),
      ).toEqual([]);
    },
  );
});
