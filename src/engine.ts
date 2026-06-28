import { config } from "./config.js";
import { World } from "./world.js";
import type { Assignment, WorldSnapshot } from "./types.js";

export type SessionStatus = "idle" | "running" | "finished";

/**
 * Manages a single session: the (event-driven) cycle loop and the assignments buffer.
 *
 * The engine no longer ticks on a fixed timer. Instead it advances **as soon as
 * the matcher submits its answer** (full speed), so the simulation runs as fast
 * as the client can respond. A per-cycle safety timeout (`cycleTimeoutMs`)
 * advances the world anyway if the client is slow or dead, so one stuck matcher
 * can never freeze the session.
 *
 * Flow of each cycle:
 *   1. The received assignments for the current snapshot are applied.
 *   2. The world advances one step (movement, pickup, cancellation, sleep, request generation).
 *   3. A new snapshot is published for the Matcher to work on, and the timeout is re-armed.
 */
export class Engine {
  world = new World();
  status: SessionStatus = "idle";
  snapshot: WorldSnapshot = this.world.snapshot();
  lastResult: { accepted: number; rejected: string[] } = { accepted: 0, rejected: [] };
  /** Name of the matcher's creator (the owning user's username). */
  creator = "";
  /** Id of the owning user — every session belongs to a logged-in user. */
  userId = "";
  /** Called each cycle with the new snapshot (for pushing over the WebSocket). */
  onSnapshot?: (snapshot: WorldSnapshot, status: SessionStatus) => void;
  /** Called once when the session reaches finished (for archiving in the database). */
  onFinish?: () => void;

  private pending: Assignment[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Per-cycle recording of the world, for replaying a finished run. */
  private frames: ReturnType<Engine["liveState"]>[] = [];
  /** Smoothed real wall-clock duration of a cycle (ms) — reported to the UI for animation. */
  private measuredCycleMs = config.cycleMs;
  private lastCycleAt = 0;

  start(): void {
    if (this.status === "running") return;
    this.reset();
    this.status = "running";
    // An initial step so the first requests get generated
    this.world.step();
    this.snapshot = this.world.snapshot();
    this.recordFrame(); // first frame of the recording
    this.lastCycleAt = Date.now();
    this.armTimeout();
  }

  /** Only stops the loop (without creating a new world) — for removing/cleaning up the session. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.world = new World();
    this.snapshot = this.world.snapshot();
    this.pending = [];
    this.frames = [];
    this.lastResult = { accepted: 0, rejected: [] };
    this.measuredCycleMs = config.cycleMs;
    this.lastCycleAt = 0;
    this.status = "idle";
  }

  /**
   * The Matcher's assignments for the current snapshot. Accepting them advances
   * the world immediately (full speed). The last submit before the advance wins.
   */
  submitAssignments(tick: number, assignments: Assignment[]): { ok: boolean; message: string } {
    if (this.status !== "running") {
      return { ok: false, message: "session is not running" };
    }
    if (tick !== this.snapshot.tick) {
      return { ok: false, message: `tick is outdated (now ${this.snapshot.tick})` };
    }
    this.pending = assignments;
    this.advance(); // event-driven: got the answer → step right away
    return { ok: true, message: `${assignments.length} assignments received` };
  }

  /** (Re)arm the safety timeout that advances the world if the client is too slow. */
  private armTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.status !== "running") return;
    this.timer = setTimeout(() => this.advance(), config.cycleTimeoutMs);
    this.timer.unref?.();
  }

  /** Advance exactly one cycle. Triggered by a client submit or by the safety timeout. */
  private advance(): void {
    if (this.status !== "running") return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    const now = Date.now();
    if (this.lastCycleAt) {
      // Exponential moving average of the real cycle duration, so the UI can
      // interpolate movement over roughly the right wall-clock time.
      const delta = now - this.lastCycleAt;
      this.measuredCycleMs = this.measuredCycleMs * 0.7 + delta * 0.3;
    }
    this.lastCycleAt = now;

    this.lastResult = this.world.applyAssignments(this.pending);
    this.pending = [];
    this.world.step();
    this.snapshot = this.world.snapshot();
    this.recordFrame(); // record this cycle for replay
    if (this.world.tick >= config.sessionTicks) {
      this.status = "finished";
      this.onFinish?.(); // session finished → archive the result in the database
    } else {
      this.armTimeout();
    }
    this.onSnapshot?.(this.snapshot, this.status); // push to matchers connected via WebSocket
  }

  /** Real measured cycle duration (ms), clamped to a sane range for the UI. */
  get cycleMs(): number {
    return Math.min(2000, Math.max(50, Math.round(this.measuredCycleMs)));
  }

  /**
   * The dynamic, per-tick part of the world (drivers, active trips, scoreboard).
   * This is exactly what the UI draws — so a recorded sequence of these frames
   * can be replayed later with the same renderer.
   */
  private liveState() {
    const w = this.world;
    return {
      tick: w.tick,
      minute: w.minute,
      drivers: [...w.drivers.values()].map((d) => ({
        id: d.id,
        pos: { ...d.pos },
        state: d.state,
        tripId: d.tripId,
      })),
      trips: [...w.trips.values()]
        .filter((t) => t.state === "REQUESTED" || t.state === "ASSIGNED" || t.state === "IN_TRANSIT")
        .map((t) => ({
          id: t.id,
          origin: { ...t.origin },
          destination: { ...t.destination },
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

  /** Append the current world state to the replay recording. */
  private recordFrame(): void {
    if (!config.recordReplays) return;
    const s = this.liveState();
    // Round positions to integers — keeps the recording compact (sub-pixel
    // precision is invisible on an 8000-unit world). Safe: liveState() returns
    // fresh copies, so this doesn't touch the live world.
    for (const d of s.drivers) { d.pos.x = Math.round(d.pos.x); d.pos.y = Math.round(d.pos.y); }
    for (const t of s.trips) {
      t.origin.x = Math.round(t.origin.x); t.origin.y = Math.round(t.origin.y);
      t.destination.x = Math.round(t.destination.x); t.destination.y = Math.round(t.destination.y);
    }
    this.frames.push(s);
  }

  /** The recorded replay: per-tick frames plus the metadata the renderer needs. */
  replay() {
    return {
      creator: this.creator,
      userId: this.userId,
      sessionTicks: config.sessionTicks,
      stepPerCycle: config.driverSpeed * config.minutesPerTick,
      world: { width: config.worldWidth, height: config.worldHeight },
      frames: this.frames,
    };
  }

  /** Full state for the UI (all drivers + active trips + scoreboard). */
  vizState() {
    return {
      creator: this.creator,
      userId: this.userId,
      status: this.status,
      sessionTicks: config.sessionTicks,
      /** Real measured cycle duration (full-speed engine), so the UI animates in sync. */
      cycleMs: this.cycleMs,
      /** Distance each driver travels in one cycle — for accurate animation prediction in the UI. */
      stepPerCycle: config.driverSpeed * config.minutesPerTick,
      world: { width: config.worldWidth, height: config.worldHeight },
      lastResult: this.lastResult,
      ...this.liveState(),
    };
  }
}
