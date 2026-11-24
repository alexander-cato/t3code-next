export type DeviceSurfaceGate = "setup" | "devices" | "loading";

/**
 * What the device tab should show.
 * `virtualMachinesEnabled` is null until the first snapshot. A later refresh keeps the last value.
 */
export function deviceSurfaceGate(input: {
  readonly onboardingCompleted: boolean;
  readonly hostDisabled: boolean;
  readonly virtualMachinesEnabled: boolean | null;
}): DeviceSurfaceGate {
  if (!input.onboardingCompleted) return "setup";
  if (!input.hostDisabled || input.virtualMachinesEnabled === true) return "devices";
  if (input.virtualMachinesEnabled === null) return "loading";
  return "setup";
}

/** false when this environment cannot run VMs. null while the first snapshot is still pending. */
export function virtualMachinesEnabledSnapshot(input: {
  readonly supported: boolean;
  readonly pending: boolean;
  readonly enabled: boolean | undefined;
}): boolean | null {
  if (!input.supported) return false;
  if (input.enabled !== undefined) return input.enabled;
  return input.pending ? null : false;
}
