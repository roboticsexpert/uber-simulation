import { Engine } from "./engine.js";
import { config } from "./config.js";
import type { SessionResult, SessionStore } from "./store.js";

const MAX_SESSIONS = 16;

// Parts for readable random names (ASCII, suitable for URLs and SESSION_ID)
const ADJ = ["brave", "calm", "swift", "lucky", "bold", "wise", "keen", "wild", "fancy", "noble", "quiet", "sunny", "merry", "clever", "jolly", "spry"];
const NOUN = ["fox", "otter", "hawk", "wolf", "lynx", "puma", "crane", "raven", "tiger", "panda", "moose", "bison", "heron", "koala", "gecko", "ibex"];

function randomName(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const suffix = Math.floor(Math.random() * 1000).toString(36);
  return `${a}-${n}-${suffix}`;
}

/**
 * Keeps several independent Engines running at the same time.
 * All sessions use one global config (the same seed and parameters),
 * so they have the same initial world and demand; their only difference comes from the Matcher's decisions.
 */
export class SessionManager {
  private sessions = new Map<string, Engine>();
  /** Cleanup timers for finished sessions — so we can cancel them on early removal. */
  private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Called when a session is removed (e.g. to close its WebSockets). */
  onEvict?: (id: string) => void;

  constructor(private store: SessionStore) {}

  create(name: string): { id: string; engine: Engine } {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`the limit of ${MAX_SESSIONS} sessions is full`);
    }
    let id = randomName();
    while (this.sessions.has(id)) id = randomName(); // avoid collisions
    const engine = new Engine();
    engine.creator = name; // creator's name (required)
    // When the session finishes: archive the result, then remove it from the Map to free memory.
    engine.onFinish = () => {
      this.store.saveResult(this.buildResult(id, engine)).catch((e) =>
        console.error(`failed to save result for session ${id}:`, e),
      );
      this.scheduleEviction(id);
    };
    this.sessions.set(id, engine);
    return { id, engine };
  }

  /**
   * Removes a finished session from memory after a grace period so we don't leak.
   * The grace period gives the UI a chance to show the final state; with ttl=0 removal is immediate.
   */
  private scheduleEviction(id: string): void {
    if (this.evictionTimers.has(id)) return; // already scheduled
    const ttl = config.finishedSessionTtlMs;
    if (ttl <= 0) {
      this.remove(id);
      return;
    }
    const timer = setTimeout(() => {
      this.evictionTimers.delete(id);
      this.remove(id);
    }, ttl);
    timer.unref?.(); // don't let this timer keep the process from shutting down
    this.evictionTimers.set(id, timer);
  }

  /** Builds the session's final result from the engine's current state. */
  private buildResult(id: string, engine: Engine): SessionResult {
    const v = engine.vizState();
    return {
      id,
      creator: engine.creator,
      ticks: v.tick,
      seed: config.seed,
      scoreboard: v.scoreboard,
      config: { ...config },
    };
  }

  get(id: string): Engine | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): boolean {
    const engine = this.sessions.get(id);
    if (!engine) return false;
    const timer = this.evictionTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.evictionTimers.delete(id);
    }
    engine.stop(); // stops the cycle timer
    // Drop the callback references so nothing prevents the engine from being freed.
    engine.onSnapshot = undefined;
    engine.onFinish = undefined;
    const deleted = this.sessions.delete(id);
    if (deleted) this.onEvict?.(id); // close this session's WebSockets
    return deleted;
  }

  /** Full summary of all sessions (each one's vizState + id). */
  listViz(): Array<{ id: string } & ReturnType<Engine["vizState"]>> {
    return [...this.sessions.entries()].map(([id, engine]) => ({
      id,
      ...engine.vizState(),
    }));
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }
}
