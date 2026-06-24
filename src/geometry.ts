import type { Vec2 } from "./types.js";

/** فاصلهٔ اقلیدسی بین دو نقطه. */
export function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * نقطه‌ای را به اندازهٔ `maxStep` به سمت `target` حرکت می‌دهد.
 * اگر فاصله کمتر از یک قدم باشد، دقیقاً روی هدف می‌نشیند.
 * خروجی: { pos: موقعیت جدید, arrived: آیا رسید }
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
 * رِیتینگ بر اساس زمان (دقیقه) طبق جدول بازی:
 *   < 1 → 5 ، ≤ 2 → 4 ، ≤ 3 → 3 ، ≤ 4 → 2 ، بیشتر → 1
 */
export function ratingFromMinutes(minutes: number): number {
  if (minutes < 1) return 5;
  if (minutes <= 2) return 4;
  if (minutes <= 3) return 3;
  if (minutes <= 4) return 2;
  return 1;
}
