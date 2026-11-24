import { describe, expect, it } from "vite-plus/test";

import { deviceSurfaceGate, virtualMachinesEnabledSnapshot } from "./deviceSurfaceGate";

describe("deviceSurfaceGate", () => {
  it("opens the device list for a finished VM-only setup", () => {
    expect(
      deviceSurfaceGate({
        onboardingCompleted: true,
        hostDisabled: true,
        virtualMachinesEnabled: true,
      }),
    ).toBe("devices");
  });

  it("keeps setup when the hub is off and macOS VMs are off", () => {
    expect(
      deviceSurfaceGate({
        onboardingCompleted: true,
        hostDisabled: true,
        virtualMachinesEnabled: false,
      }),
    ).toBe("setup");
  });

  it("waits for the first VM snapshot instead of opening setup", () => {
    expect(
      virtualMachinesEnabledSnapshot({ supported: true, pending: true, enabled: undefined }),
    ).toBeNull();
    expect(
      deviceSurfaceGate({
        onboardingCompleted: true,
        hostDisabled: true,
        virtualMachinesEnabled: null,
      }),
    ).toBe("loading");
  });

  it("keeps the last VM snapshot while a refresh is pending", () => {
    expect(virtualMachinesEnabledSnapshot({ supported: true, pending: true, enabled: true })).toBe(
      true,
    );
  });

  it("keeps setup until onboarding is finished", () => {
    expect(
      deviceSurfaceGate({
        onboardingCompleted: false,
        hostDisabled: false,
        virtualMachinesEnabled: true,
      }),
    ).toBe("setup");
  });
});
