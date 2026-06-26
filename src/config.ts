/**
 * All tunable simulation parameters in one place.
 * Values are currently approximate and will be tuned later (per the team's request).
 * Every value can be overridden via env so tuning is possible without changing code.
 */

const num = (name: string, def: number): number => {
  const v = process.env[name];
  return v === undefined ? def : Number(v);
};

export const config = {
  // ---- map / world ----
  worldWidth: num("WORLD_WIDTH", 8_000),
  worldHeight: num("WORLD_HEIGHT", 8_000),

  // ---- time / session ----
  /** How many real milliseconds each cycle lasts (user's request: 30 seconds). */
  cycleMs: num("CYCLE_MS", 1_000),
  /** How many cycles a session lasts. 2 hours / 30 seconds = 240. */
  sessionTicks: num("SESSION_TICKS", 240),
  /**
   * After a session finishes, how many milliseconds to keep it in memory so the UI can
   * show the final state, then clear it (preventing a memory leak). Zero = immediate removal.
   */
  finishedSessionTtlMs: num("FINISHED_SESSION_TTL_MS", 30_000),
  /** How many "game minutes" each cycle corresponds to. */
  minutesPerTick: num("MINUTES_PER_TICK", 1),

  // ---- drivers ----
  driverCount: num("DRIVER_COUNT", 80),
  /** Driver speed: distance units per game minute. (placeholder — will be tuned) */
  driverSpeed: num("DRIVER_SPEED", 650),
  /** No trip for this duration (minutes) → sleep. */
  driverIdleSleepMinutes: num("DRIVER_IDLE_SLEEP", 30),
  /** How long a driver sleeps (minutes) before waking up. */
  driverSleepMinutes: num("DRIVER_SLEEP", 60),

  // ---- riders / requests ----
  /** Average number of new requests per cycle (Poisson distribution). */
  riderArrivalRate: num("RIDER_ARRIVAL_RATE", 10),
  /** Maximum rider patience (minutes) from request to pickup. */
  riderPatienceMinutes: num("RIDER_PATIENCE", 4),

  // ---- fare ----
  baseFare: num("BASE_FARE", 5),
  perDistanceFare: num("PER_DISTANCE_FARE", 1.5),

  // ---- network ----
  port: num("PORT", 8080),
  /** Seed for scenario reproducibility (competition fairness). */
  seed: num("SEED", 42),
} as const;

export type Config = typeof config;
