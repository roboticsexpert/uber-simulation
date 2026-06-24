/**
 * تمام پارامترهای قابل تیون شبیه‌سازی در یک جا.
 * مقادیر فعلاً تقریبی‌اند و بعداً تیون می‌شوند (طبق خواستهٔ تیم).
 * هر مقدار با env قابل override است تا تیون‌کردن بدون تغییر کد ممکن باشد.
 */

const num = (name: string, def: number): number => {
  const v = process.env[name];
  return v === undefined ? def : Number(v);
};

export const config = {
  // ---- نقشه / دنیا ----
  worldWidth: num("WORLD_WIDTH", 100),
  worldHeight: num("WORLD_HEIGHT", 100),

  // ---- زمان / session ----
  /** هر cycle چند میلی‌ثانیهٔ واقعی طول می‌کشد (خواستهٔ کاربر: 30 ثانیه). */
  cycleMs: num("CYCLE_MS", 30_000),
  /** session چند cycle طول می‌کشد. 2 ساعت / 30 ثانیه = 240. */
  sessionTicks: num("SESSION_TICKS", 240),
  /** هر cycle معادل چند «دقیقهٔ بازی» است. */
  minutesPerTick: num("MINUTES_PER_TICK", 1),

  // ---- رانندگان ----
  driverCount: num("DRIVER_COUNT", 20),
  /** سرعت راننده: واحد فاصله بر دقیقهٔ بازی. (placeholder — تیون می‌شود) */
  driverSpeed: num("DRIVER_SPEED", 8),
  /** بدون سفر در این مدت (دقیقه) → خواب. */
  driverIdleSleepMinutes: num("DRIVER_IDLE_SLEEP", 30),
  /** مدت خواب راننده (دقیقه) قبل از بیداری. */
  driverSleepMinutes: num("DRIVER_SLEEP", 60),

  // ---- مسافران / درخواست‌ها ----
  /** میانگین تعداد درخواست جدید در هر cycle (توزیع پواسون). */
  riderArrivalRate: num("RIDER_ARRIVAL_RATE", 2),
  /** سقف صبر مسافر (دقیقه) از درخواست تا pickup. */
  riderPatienceMinutes: num("RIDER_PATIENCE", 5),

  // ---- هزینه ----
  baseFare: num("BASE_FARE", 5),
  perDistanceFare: num("PER_DISTANCE_FARE", 1.5),

  // ---- شبکه ----
  port: num("PORT", 8080),
  /** seed برای تکرارپذیری سناریو (عدالت مسابقه). */
  seed: num("SEED", 42),
} as const;

export type Config = typeof config;
