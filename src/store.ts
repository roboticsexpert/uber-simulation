import postgres from "postgres";

/** The final result of a finished session — exactly what gets archived in the database. */
export interface SessionResult {
  id: string;
  /** The matcher creator's name (required). */
  creator: string;
  /** The final tick (usually equal to sessionTicks). */
  ticks: number;
  /** The scenario seed, for reproducibility/comparison. */
  seed: number;
  scoreboard: {
    completed: number;
    cancelled: number;
    revenue: number;
    riderRatingSum: number;
    riderRatingCount: number;
    riderAvg: number;
    driverRatingSum: number;
    driverRatingCount: number;
    driverAvg: number;
  };
  /** A snapshot of the session config, for context. */
  config: Record<string, number>;
}

export interface SessionStore {
  /** Create the required table if it doesn't exist. */
  init(): Promise<void>;
  /** Archive a finished session (idempotent). */
  saveResult(result: SessionResult): Promise<void>;
  /** Read archived results for the leaderboard/display. */
  listResults(limit?: number): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** Postgres implementation. On Railway it uses the injected DATABASE_URL. */
class PostgresStore implements SessionStore {
  private sql: ReturnType<typeof postgres>;

  constructor(url: string) {
    this.sql = postgres(url, { onnotice: () => {} });
  }

  async init(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS session_results (
        id          TEXT PRIMARY KEY,
        creator     TEXT NOT NULL DEFAULT '',
        finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ticks       INTEGER NOT NULL,
        seed        INTEGER NOT NULL,
        completed   INTEGER NOT NULL,
        cancelled   INTEGER NOT NULL,
        revenue     DOUBLE PRECISION NOT NULL,
        rider_avg   DOUBLE PRECISION NOT NULL,
        driver_avg  DOUBLE PRECISION NOT NULL,
        scoreboard  JSONB NOT NULL,
        config      JSONB NOT NULL
      )`;
    // Idempotent migration for tables that were created earlier without the creator column.
    await this.sql`ALTER TABLE session_results ADD COLUMN IF NOT EXISTS creator TEXT NOT NULL DEFAULT ''`;
    // The internal matcher was removed — all sessions run with an external matcher; drop the old column.
    await this.sql`ALTER TABLE session_results DROP COLUMN IF EXISTS auto_match`;
  }

  async saveResult(r: SessionResult): Promise<void> {
    const s = r.scoreboard;
    await this.sql`
      INSERT INTO session_results
        (id, creator, ticks, seed, completed, cancelled, revenue, rider_avg, driver_avg, scoreboard, config)
      VALUES
        (${r.id}, ${r.creator}, ${r.ticks}, ${r.seed}, ${s.completed}, ${s.cancelled},
         ${s.revenue}, ${s.riderAvg}, ${s.driverAvg}, ${this.sql.json(s)}, ${this.sql.json(r.config)})
      ON CONFLICT (id) DO UPDATE SET
        finished_at = now(),
        creator     = EXCLUDED.creator,
        ticks       = EXCLUDED.ticks,
        seed        = EXCLUDED.seed,
        completed   = EXCLUDED.completed,
        cancelled   = EXCLUDED.cancelled,
        revenue     = EXCLUDED.revenue,
        rider_avg   = EXCLUDED.rider_avg,
        driver_avg  = EXCLUDED.driver_avg,
        scoreboard  = EXCLUDED.scoreboard,
        config      = EXCLUDED.config`;
  }

  async listResults(limit = 50): Promise<Record<string, unknown>[]> {
    const rows = await this.sql`
      SELECT id, creator, finished_at, ticks, seed, completed, cancelled,
             revenue, rider_avg, driver_avg, scoreboard, config
      FROM session_results
      ORDER BY revenue DESC, finished_at DESC
      LIMIT ${limit}`;
    return rows as unknown as Record<string, unknown>[];
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/** When DATABASE_URL is absent (e.g. local) — stores nothing so development doesn't break. */
class NullStore implements SessionStore {
  async init(): Promise<void> {
    console.warn("⚠️  DATABASE_URL is not set — session results will not be stored (NullStore).");
  }
  async saveResult(): Promise<void> {}
  async listResults(): Promise<Record<string, unknown>[]> {
    return [];
  }
  async close(): Promise<void> {}
}

/** Builds the appropriate store based on whether DATABASE_URL exists. */
export function createStore(): SessionStore {
  const url = process.env.DATABASE_URL;
  return url ? new PostgresStore(url) : new NullStore();
}
