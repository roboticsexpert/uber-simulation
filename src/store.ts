import postgres from "postgres";

/** نتیجهٔ نهاییِ یک سشنِ تمام‌شده — همان چیزی که در دیتابیس آرشیو می‌شود. */
export interface SessionResult {
  id: string;
  /** نامِ سازندهٔ ماتچر (اجباری). */
  creator: string;
  /** ماتچرِ داخلیِ greedy بوده یا ماتچرِ بیرونی. */
  autoMatch: boolean;
  /** tickِ نهایی (معمولاً برابر sessionTicks). */
  ticks: number;
  /** seedِ سناریو، برای تکرارپذیری/مقایسه. */
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
  /** snapshot از configِ سشن، برای context. */
  config: Record<string, number>;
}

export interface SessionStore {
  /** ساختِ جدولِ مورد نیاز اگر وجود نداشته باشد. */
  init(): Promise<void>;
  /** آرشیوِ یک سشنِ تمام‌شده (idempotent). */
  saveResult(result: SessionResult): Promise<void>;
  /** خواندنِ نتایجِ آرشیوشده برای leaderboard/نمایش. */
  listResults(limit?: number): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** پیاده‌سازیِ Postgres. روی Railway از DATABASE_URLِ تزریق‌شده استفاده می‌کند. */
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
        auto_match  BOOLEAN NOT NULL,
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
    // migrationِ idempotent برای جدول‌هایی که از قبل بدونِ ستونِ creator ساخته شده‌اند.
    await this.sql`ALTER TABLE session_results ADD COLUMN IF NOT EXISTS creator TEXT NOT NULL DEFAULT ''`;
  }

  async saveResult(r: SessionResult): Promise<void> {
    const s = r.scoreboard;
    await this.sql`
      INSERT INTO session_results
        (id, creator, auto_match, ticks, seed, completed, cancelled, revenue, rider_avg, driver_avg, scoreboard, config)
      VALUES
        (${r.id}, ${r.creator}, ${r.autoMatch}, ${r.ticks}, ${r.seed}, ${s.completed}, ${s.cancelled},
         ${s.revenue}, ${s.riderAvg}, ${s.driverAvg}, ${this.sql.json(s)}, ${this.sql.json(r.config)})
      ON CONFLICT (id) DO UPDATE SET
        finished_at = now(),
        creator     = EXCLUDED.creator,
        auto_match  = EXCLUDED.auto_match,
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
      SELECT id, creator, finished_at, auto_match, ticks, seed, completed, cancelled,
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

/** وقتی DATABASE_URL نباشد (مثلاً لوکال) — هیچ ذخیره‌ای نمی‌کند تا توسعه نشکند. */
class NullStore implements SessionStore {
  async init(): Promise<void> {
    console.warn("⚠️  DATABASE_URL تنظیم نشده — نتایجِ سشن‌ها ذخیره نمی‌شوند (NullStore).");
  }
  async saveResult(): Promise<void> {}
  async listResults(): Promise<Record<string, unknown>[]> {
    return [];
  }
  async close(): Promise<void> {}
}

/** بر اساس وجودِ DATABASE_URL، storeِ مناسب را می‌سازد. */
export function createStore(): SessionStore {
  const url = process.env.DATABASE_URL;
  return url ? new PostgresStore(url) : new NullStore();
}
