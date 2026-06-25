import { config } from "./config.js";
import { World } from "./world.js";
import type { Assignment, WorldSnapshot } from "./types.js";

export type SessionStatus = "idle" | "running" | "finished";

/**
 * Manages a single session: the cycle loop, scheduling, and the assignments buffer.
 *
 * Flow of each cycle (every `cycleMs`):
 *   1. The received assignments for the current snapshot are applied.
 *   2. The world advances one step (movement, pickup, cancellation, sleep, request generation).
 *   3. A new snapshot is published for the Matcher to work on.
 */
export class Engine {
  world = new World();
  status: SessionStatus = "idle";
  snapshot: WorldSnapshot = this.world.snapshot();
  lastResult: { accepted: number; rejected: string[] } = { accepted: 0, rejected: [] };
  /** Name of the matcher's creator — required, set when the session is created. */
  creator = "";
  /** Called each cycle with the new snapshot (for pushing over the WebSocket). */
  onSnapshot?: (snapshot: WorldSnapshot, status: SessionStatus) => void;
  /** Called once when the session reaches finished (for archiving in the database). */
  onFinish?: () => void;

  private pending: Assignment[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.status === "running") return;
    this.reset();
    this.status = "running";
    // An initial step so the first requests get generated
    this.world.step();
    this.snapshot = this.world.snapshot();
    this.timer = setInterval(() => this.cycle(), config.cycleMs);
  }

  /** Only stops the cycle loop (without creating a new world) — for removing/cleaning up the session. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reset(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.world = new World();
    this.snapshot = this.world.snapshot();
    this.pending = [];
    this.lastResult = { accepted: 0, rejected: [] };
    this.status = "idle";
  }

  /** The Matcher's assignments for the current snapshot. The last POST determines the whole set. */
  submitAssignments(tick: number, assignments: Assignment[]): { ok: boolean; message: string } {
    if (this.status !== "running") {
      return { ok: false, message: "session is not running" };
    }
    if (tick !== this.snapshot.tick) {
      return { ok: false, message: `tick is outdated (now ${this.snapshot.tick})` };
    }
    this.pending = assignments;
    return { ok: true, message: `${assignments.length} assignments received` };
  }

  private cycle(): void {
    this.lastResult = this.world.applyAssignments(this.pending);
    this.pending = [];
    this.world.step();
    this.snapshot = this.world.snapshot();
    if (this.world.tick >= config.sessionTicks) {
      this.status = "finished";
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.onFinish?.(); // session finished → archive the result in the database
    }
    this.onSnapshot?.(this.snapshot, this.status); // push to matchers connected via WebSocket
  }

  /** Full state for the UI (all drivers + active trips + scoreboard). */
  vizState() {
    const w = this.world;
    return {
      creator: this.creator,
      status: this.status,
      tick: w.tick,
      minute: w.minute,
      sessionTicks: config.sessionTicks,
      cycleMs: config.cycleMs,
      /** Distance each driver travels in one cycle — for accurate animation prediction in the UI. */
      stepPerCycle: config.driverSpeed * config.minutesPerTick,
      world: { width: config.worldWidth, height: config.worldHeight },
      lastResult: this.lastResult,
      drivers: [...w.drivers.values()].map((d) => ({
        id: d.id,
        pos: d.pos,
        state: d.state,
        tripId: d.tripId,
      })),
      trips: [...w.trips.values()]
        .filter((t) => t.state === "REQUESTED" || t.state === "ASSIGNED" || t.state === "IN_TRANSIT")
        .map((t) => ({
          id: t.id,
          origin: t.origin,
          destination: t.destination,
          state: t.state,
          driverId: t.driverId,
          waitedMinutes: (w.tick - t.requestedTick) * config.minutesPerTick,
        })),
      scoreboard: {
        ...w.scoreboard,
        riderAvg: w.scoreboard.riderRatingCount
          ? w.scoreboard.riderRatingSum / w.scoreboard.riderRatingCount
          : 0,
        driverAvg: w.scoreboard.driverRatingCount
          ? w.scoreboard.driverRatingSum / w.scoreboard.driverRatingCount
          : 0,
      },
    };
  }
}
