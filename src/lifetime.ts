export const MAX_LIFETIME_MS = 30 * 60_000;

export type LifetimePlan =
  | { action: "expire"; legacy: boolean }
  | { action: "wait"; delaySeconds: number };

/**
 * Decides what a running sandbox container should do about its hard lifetime cap.
 * `startedAt` is when the container was first seen starting. A running container with no
 * record predates the cap, so it is expired right away.
 */
export function planLifetime(
  startedAt: number | undefined,
  now: number,
  maxMs: number = MAX_LIFETIME_MS,
): LifetimePlan {
  if (startedAt === undefined) {
    return { action: "expire", legacy: true };
  }
  const remaining = startedAt + maxMs - now;
  if (remaining <= 0) {
    return { action: "expire", legacy: false };
  }
  return { action: "wait", delaySeconds: Math.ceil(remaining / 1000) };
}
