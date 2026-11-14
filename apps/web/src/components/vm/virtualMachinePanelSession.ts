import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

// Client opens also publish sessions; only externally opened sessions should activate a new tab.
const pendingOpens = new Map<string, number>();
const pendingKey = (threadRef: ScopedThreadRef, name: string) =>
  `${scopedThreadKey(threadRef)}:${name}`;

export function trackVirtualMachineOpen(threadRef: ScopedThreadRef, name: string) {
  const key = pendingKey(threadRef, name);
  pendingOpens.set(key, (pendingOpens.get(key) ?? 0) + 1);
  return () => {
    const remaining = (pendingOpens.get(key) ?? 1) - 1;
    if (remaining > 0) pendingOpens.set(key, remaining);
    else pendingOpens.delete(key);
  };
}

export function isVirtualMachineOpeningLocally(threadRef: ScopedThreadRef, name: string) {
  return pendingOpens.has(pendingKey(threadRef, name));
}

// A tab the user opens or restores starts its VM. A remount over a closed session leaves it closed.
const openRequests = new Set<string>();

export function requestVirtualMachineOpen(threadRef: ScopedThreadRef, name: string) {
  openRequests.add(pendingKey(threadRef, name));
}

export function takeVirtualMachineOpen(threadRef: ScopedThreadRef, name: string) {
  return openRequests.delete(pendingKey(threadRef, name));
}
