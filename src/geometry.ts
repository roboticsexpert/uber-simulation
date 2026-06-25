import type { Vec2 } from "./types.js";

/** Euclidean distance between two points. */
export function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Moves a point toward `target` by at most `maxStep`.
 * If the distance is less than one step, it lands exactly on the target.
 * Returns: { pos: new position, arrived: whether it reached the target }
 */
export function moveToward(
  from: Vec2,
  target: Vec2,
  maxStep: number,
): { pos: Vec2; arrived: boolean } {
  const d = distance(from, target);
  if (d <= maxStep || d === 0) {
    return { pos: { x: target.x, y: target.y }, arrived: true };
  }
  const t = maxStep / d;
  return {
    pos: { x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t },
    arrived: false,
  };
}

/**
 * Rating based on time (minutes) per the game's table:
 *   < 1 → 5, ≤ 2 → 4, ≤ 3 → 3, ≤ 4 → 2, more → 1
 */
export function ratingFromMinutes(minutes: number): number {
  if (minutes < 1) return 5;
  if (minutes <= 2) return 4;
  if (minutes <= 3) return 3;
  if (minutes <= 4) return 2;
  return 1;
}
