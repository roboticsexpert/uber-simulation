import postgres from "postgres";

/** A registered participant. The token is the matcher client's identity. */
export interface User {
  id: string;
  /** Display name (original casing). */
  username: string;
  /** Lowercased username — the key for uniqueness and login. */
  usernameLc: string;
  /** scrypt password hash (`scrypt$salt$hash`). */
  password: string;
  /** API token the matcher client sends to prove who it is. */
  token: string;
}

/** The final result of a finished session — exactly what gets archived in the database. */
export interface SessionResult {
  id: string;
  /** The owning user's id (every session belongs to a logged-in user). */
  userId: string;
  /** The owner's username (denormalized for display). */
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
  /** Create the required tables if they don't exist. */
  init(): Promise<void>;

  // ---- users / auth ----
  createUser(user: User): Promise<void>;
  /** Look a user up by lowercased username (for login/registration). */
  getUserByUsername(usernameLc: string): Promise<User | undefined>;
  /** Look a user up by API token (for gating the matcher client). */
  getUserByToken(token: string): Promise<User | undefined>;

  // ---- results ----
  /** Archive a finished session (idempotent). */
  saveResult(result: SessionResult): Promise<void>;
  /** Every finished session, newest/best first — public, anyone can see them all. */
  listResults(limit?: number): Promise<Record<string, unknown>[]>;
  /** A single user's finished sessions (their personal scoreboard). */
  listResultsByUser(userId: string, limit?: number): Promise<Record<string, unknown>[]>;
  /** One row per user — their best run — for the per-user leaderboard. */
  leaderboard(limit?: number): Promise<Record<string, unknown>[]>;

  // ---- replays ----
  /** Store a finished run's frame-by-frame recording (idempotent). */
  saveReplay(id: string, replay: unknown): Promise<void>;
  /** Fetch a recorded run for playback (undefined if none). */
  getReplay(id: string): Promise<unknown | undefined>;

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
      CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        username    TEXT NOT NULL,
        username_lc TEXT UNIQUE NOT NULL,
        password    TEXT NOT NULL,
        token       TEXT UNIQUE NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS session_results (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL DEFAULT '',
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
    // Idempotent migrations for tables created by earlier versions.
    await this.sql`ALTER TABLE session_results ADD COLUMN IF NOT EXISTS creator TEXT NOT NULL DEFAULT ''`;
    await this.sql`ALTER TABLE session_results ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''`;
    await this.sql`ALTER TABLE session_results DROP COLUMN IF EXISTS auto_match`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_results_user ON session_results (user_id)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS session_replays (
        id         TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        data       JSONB NOT NULL
      )`;
  }

  async createUser(u: User): Promise<void> {
    await this.sql`
      INSERT INTO users (id, username, username_lc, password, token)
      VALUES (${u.id}, ${u.username}, ${u.usernameLc}, ${u.password}, ${u.token})`;
  }

  async getUserByUsername(usernameLc: string): Promise<User | undefined> {
    const rows = await this.sql<User[]>`
      SELECT id, username, username_lc AS "usernameLc", password, token
      FROM users WHERE username_lc = ${usernameLc} LIMIT 1`;
    return rows[0];
  }

  async getUserByToken(token: string): Promise<User | undefined> {
    const rows = await this.sql<User[]>`
      SELECT id, username, username_lc AS "usernameLc", password, token
      FROM users WHERE token = ${token} LIMIT 1`;
    return rows[0];
  }

  async saveResult(r: SessionResult): Promise<void> {
    const s = r.scoreboard;
    await this.sql`
      INSERT INTO session_results
        (id, user_id, creator, ticks, seed, completed, cancelled, revenue, rider_avg, driver_avg, scoreboard, config)
      VALUES
        (${r.id}, ${r.userId}, ${r.creator}, ${r.ticks}, ${r.seed}, ${s.completed}, ${s.cancelled},
         ${s.revenue}, ${s.riderAvg}, ${s.driverAvg}, ${this.sql.json(s)}, ${this.sql.json(r.config)})
      ON CONFLICT (id) DO UPDATE SET
        finished_at = now(),
        user_id     = EXCLUDED.user_id,
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

  async listResults(limit = 100): Promise<Record<string, unknown>[]> {
    const rows = await this.sql`
      SELECT id, user_id, creator, finished_at, ticks, seed, completed, cancelled,
             revenue, rider_avg, driver_avg, scoreboard, config
      FROM session_results
      ORDER BY finished_at DESC
      LIMIT ${limit}`;
    return rows as unknown as Record<string, unknown>[];
  }

  async listResultsByUser(userId: string, limit = 100): Promise<Record<string, unknown>[]> {
    const rows = await this.sql`
      SELECT id, user_id, creator, finished_at, ticks, seed, completed, cancelled,
             revenue, rider_avg, driver_avg, scoreboard, config
      FROM session_results
      WHERE user_id = ${userId}
      ORDER BY finished_at DESC
      LIMIT ${limit}`;
    return rows as unknown as Record<string, unknown>[];
  }

  async leaderboard(limit = 100): Promise<Record<string, unknown>[]> {
    // One row per user: their single best run (highest revenue), plus how many runs they have.
    const rows = await this.sql`
      SELECT DISTINCT ON (user_id)
             user_id, creator, id, finished_at, revenue, completed, cancelled,
             rider_avg, driver_avg, ticks,
             COUNT(*) OVER (PARTITION BY user_id) AS runs
      FROM session_results
      WHERE user_id <> ''
      ORDER BY user_id, revenue DESC, finished_at DESC`;
    const arr = rows as unknown as Record<string, unknown>[];
    arr.sort((a, b) => Number(b.revenue) - Number(a.revenue));
    return arr.slice(0, limit);
  }

  async saveReplay(id: string, replay: unknown): Promise<void> {
    await this.sql`
      INSERT INTO session_replays (id, data) VALUES (${id}, ${this.sql.json(replay as any)})
      ON CONFLICT (id) DO UPDATE SET created_at = now(), data = EXCLUDED.data`;
  }

  async getReplay(id: string): Promise<unknown | undefined> {
    const rows = await this.sql`SELECT data FROM session_replays WHERE id = ${id} LIMIT 1`;
    return rows[0]?.data;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/**
 * In-memory fallback used when DATABASE_URL is absent (e.g. local dev).
 * Keeps users + results for the lifetime of the process so login and the
 * scoreboard work locally — they're just not persisted across restarts.
 */
class MemoryStore implements SessionStore {
  private users = new Map<string, User>(); // usernameLc → user
  private byToken = new Map<string, User>(); // token → user
  private results = new Map<string, SessionResult & { finished_at: string }>();
  private replays = new Map<string, unknown>();

  async init(): Promise<void> {
    console.warn("⚠️  DATABASE_URL is not set — using in-memory store (data is lost on restart).");
  }

  async createUser(u: User): Promise<void> {
    this.users.set(u.usernameLc, u);
    this.byToken.set(u.token, u);
  }
  async getUserByUsername(usernameLc: string): Promise<User | undefined> {
    return this.users.get(usernameLc);
  }
  async getUserByToken(token: string): Promise<User | undefined> {
    return this.byToken.get(token);
  }

  async saveResult(r: SessionResult): Promise<void> {
    this.results.set(r.id, { ...r, finished_at: new Date().toISOString() });
  }

  private flatten(r: SessionResult & { finished_at: string }): Record<string, unknown> {
    const s = r.scoreboard;
    return {
      id: r.id, user_id: r.userId, creator: r.creator, finished_at: r.finished_at,
      ticks: r.ticks, seed: r.seed, completed: s.completed, cancelled: s.cancelled,
      revenue: s.revenue, rider_avg: s.riderAvg, driver_avg: s.driverAvg,
      scoreboard: s, config: r.config,
    };
  }

  async listResults(limit = 100): Promise<Record<string, unknown>[]> {
    return [...this.results.values()]
      .sort((a, b) => b.finished_at.localeCompare(a.finished_at))
      .slice(0, limit)
      .map((r) => this.flatten(r));
  }

  async listResultsByUser(userId: string, limit = 100): Promise<Record<string, unknown>[]> {
    return [...this.results.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.finished_at.localeCompare(a.finished_at))
      .slice(0, limit)
      .map((r) => this.flatten(r));
  }

  async leaderboard(limit = 100): Promise<Record<string, unknown>[]> {
    const best = new Map<string, SessionResult & { finished_at: string }>();
    const runs = new Map<string, number>();
    for (const r of this.results.values()) {
      if (!r.userId) continue;
      runs.set(r.userId, (runs.get(r.userId) ?? 0) + 1);
      const cur = best.get(r.userId);
      if (!cur || r.scoreboard.revenue > cur.scoreboard.revenue) best.set(r.userId, r);
    }
    return [...best.values()]
      .sort((a, b) => b.scoreboard.revenue - a.scoreboard.revenue)
      .slice(0, limit)
      .map((r) => ({ ...this.flatten(r), runs: runs.get(r.userId) ?? 1 }));
  }

  async saveReplay(id: string, replay: unknown): Promise<void> {
    this.replays.set(id, replay);
  }
  async getReplay(id: string): Promise<unknown | undefined> {
    return this.replays.get(id);
  }

  async close(): Promise<void> {}
}

/** Builds the appropriate store based on whether DATABASE_URL exists. */
export function createStore(): SessionStore {
  const url = process.env.DATABASE_URL;
  return url ? new PostgresStore(url) : new MemoryStore();
}
