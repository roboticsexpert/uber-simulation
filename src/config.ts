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
  /**
   * Nominal cycle duration (ms). The engine no longer sleeps a fixed amount each
   * cycle — it advances as soon as the matcher submits its answer (full speed).
   * This value is only a hint for the UI's movement interpolation; the real
   * cycle duration is measured live and reported back to the UI.
   */
  cycleMs: num("CYCLE_MS", 1_000),
  /**
   * Safety timeout (ms): if the matcher does not submit within this window, the
   * engine advances anyway with whatever assignments it has (possibly none), so
   * a slow or dead client can never stall the whole session.
   */
  cycleTimeoutMs: num("CYCLE_TIMEOUT_MS", 10_000),
  /** How many cycles a session lasts. 2 hours / 30 seconds = 240. */
  sessionTicks: num("SESSION_TICKS", 240),
  /**
   * After a session finishes, how many milliseconds to keep it in memory so the UI can
   * show the final state, then clear it (preventing a memory leak). Zero = immediate removal.
   */
  finishedSessionTtlMs: num("FINISHED_SESSION_TTL_MS", 30_000),
  /** How many "game minutes" each cycle corresponds to. */
  minutesPerTick: num("MINUTES_PER_TICK", 1),
  /** Record every run frame-by-frame so it can be replayed afterwards. (1 = on, 0 = off) */
  recordReplays: num("RECORD_REPLAYS", 1),

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
};

/**
 * A full set of simulation parameters. Every value is a plain number so a city
 * preset (below) can override any subset of them.
 */
export type Config = typeof config;

/**
 * A named "city": a baseline-plus-overrides world flavour. Only the parameters
 * that differ from {@link config} are listed in `overrides`; everything else
 * falls back to the default. Each city carries its own `seed` so that everyone
 * who tests against the same city gets the exact same demand and initial world —
 * which keeps cross-matcher comparison within a city fair and reproducible.
 */
export interface City {
  id: string;
  name: string;
  description: string;
  overrides: Partial<Config>;
}

export const cities: City[] = [
  {
    id: "default",
    name: "Metropolis",
    description: "Balanced baseline — the original tuning, a fair all-rounder.",
    overrides: {},
  },
  {
    id: "manhattan",
    name: "Manhattan",
    description: "Dense core: small map, heavy demand, many drivers, impatient riders.",
    overrides: {
      worldWidth: 4_000,
      worldHeight: 4_000,
      driverCount: 120,
      riderArrivalRate: 18,
      riderPatienceMinutes: 3,
      seed: 101,
    },
  },
  {
    id: "suburb",
    name: "Suburbia",
    description: "Sprawling and sparse: big map, light demand, few scattered drivers.",
    overrides: {
      worldWidth: 12_000,
      worldHeight: 12_000,
      driverCount: 40,
      riderArrivalRate: 5,
      riderPatienceMinutes: 6,
      seed: 202,
    },
  },
  {
    id: "rush-hour",
    name: "Rush Hour",
    description: "Demand spike with thin patience — queueing and prioritization under load.",
    overrides: {
      driverCount: 70,
      riderArrivalRate: 28,
      riderPatienceMinutes: 2,
      seed: 303,
    },
  },
  {
    id: "night-shift",
    name: "Night Shift",
    description: "Scarce supply: few drivers, long sleeps, scattered demand.",
    overrides: {
      driverCount: 30,
      riderArrivalRate: 6,
      driverIdleSleepMinutes: 20,
      driverSleepMinutes: 90,
      seed: 404,
    },
  },
];

/** Look up a city by id, falling back to the first (default) city. */
export function getCity(cityId?: string): City {
  return cities.find((c) => c.id === cityId) ?? cities[0];
}

/** Build the full Config for a city: the base config with that city's overrides applied. */
export function resolveConfig(cityId?: string): Config {
  return { ...config, ...getCity(cityId).overrides };
}
