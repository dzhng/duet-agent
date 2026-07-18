import type { TaskDescriptor } from "./types.js";

/** The runner must remain awake while in-process work exists. */
export type PendingWork =
  | { kind: "open" }
  | { kind: "sleep"; wakeAt: number }
  | { kind: "complete" };

/** Decide the terminal posture from serializable task descriptors alone. */
export function computePendingWork(descriptors: readonly TaskDescriptor[]): PendingWork {
  if (descriptors.some((descriptor) => descriptor.status === "running")) {
    return { kind: "open" };
  }

  const wakeTimes = descriptors.flatMap((descriptor) =>
    descriptor.status === "scheduled" && descriptor.wakeAt !== undefined ? [descriptor.wakeAt] : [],
  );
  if (wakeTimes.length > 0) return { kind: "sleep", wakeAt: Math.min(...wakeTimes) };
  return { kind: "complete" };
}
