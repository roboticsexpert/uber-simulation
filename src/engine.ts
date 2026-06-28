import type { Config } from "./config.js";
import { World } from "./world.js";
import type { Assignment, Scoreboard, WorldSnapshot } from "./types.js";

export type SessionStatus = "idle" | "running" | "finished";

/** One city in a session's run: the city's identity plus its resolved parameters. */
export interface Leg {
  cityId: string;
  cityName: string;
  cfg: Config;
}

/** A scoreboard with all counters at zero — the identity element for summing. */
function emptyScoreboard(): Scoreboard {
  return {
    completed: 0,
    cancelled: 0,
    riderRatingSum: 0,
    riderRatingCount: 0,
    driverRatingSum: 0,
    driverRatingCount: 0,
    revenue: 0,
  };
}

/** Fold one scoreboard into an accumulator (sums every counter). */
function addScoreboard(into: Scoreboard, s: Scoreboard): void {
  into.completed += s.completed;
  into.cancelled += s.cancelled;
  into.riderRatingSum += s.riderRatingSum;
  into.riderRatingCount += s.riderRatingCount;
  into.driverRatingSum += s.driverRatingSum;
  into.driverRatingCount += s.driverRatingCount;
  into.revenue += s.revenue;
}

/**
 * Attach the derived rating averages to a scoreboard. Because the sums and counts
 * are summed across cities first, the resulting averages are correctly *weighted*
 * by each city's trip volume (not a mean-of-means).
 */
function withAvgs(s: Scoreboard) {
  return {
    ...s,
    riderAvg: s.riderRatingCount ? s.riderRatingSum / s.riderRatingCount : 0,
    driverAvg: s.driverRatingCount ? s.driverRatingSum / s.driverRatingCount : 0,
  };
}

/**
 * Manages a single session: the (event-driven) cycle loop and the assignments buffer.
 *
 * A session plays a sequence of cities ("legs") back-to-back on one connection
 * (a "gauntlet"). When a leg's world reaches `sessionTicks`, its scoreboard is
 * banked and the next city's world starts from tick 0 on the same connection —
 * the matcher just keeps answering snapshots. The session's **final result is the
 * sum across all legs**, so the same matcher code is judged on every world.
 * A single-city session is simply a gauntlet of length one.
 *
 * The engine does not tick on a fixed timer. It advances **as soon as the matcher
 * submits its answer** (full speed). A per-cycle safety timeout (`cycleTimeoutMs`)
 * advances the world anyway if the client is slow or dead, so one stuck matcher
 * can never freeze the session.
 *
 * Flow of each cycle:
 *   1. The received assignments for the current snapshot are applied.
 *   2. The world advances one step (movement, pickup, cancellation, sleep, request generation).
 *   3. If the leg is over, bank it and start the next city (or finish).
 *   4. A new snapshot is published for the Matcher to work on, and the timeout is re-armed.
 */
export class Engine {
  world: World;
  status: SessionStatus = "idle";
  snapshot: WorldSnapshot;
  lastResult: { accepted: number; rejected: string[] } = { accepted: 0, rejected: [] };
  /** Name of the matcher's creator (the owning user's username). */
  creator = "";
  /** Id of the owning user — every session belongs to a logged-in user. */
  userId = "";
  /** Session identity: a single city's id/name, or "gauntlet" when several cities are chained. */
  cityId: string;
  cityName: string;
  /** Called each cycle with the new snapshot (for pushing over the WebSocket). */
  onSnapshot?: (snapshot: WorldSnapshot, status: SessionStatus) => void;
  /** Called once when the session reaches finished (for archiving in the database). */
  onFinish?: () => void;

  private legIndex = 0;
  /** Banked scoreboards of the legs that have finished so far (current leg excluded until it ends). */
  private finishedLegs: { cityId: string; cityName: string; scoreboard: Scoreboard }[] = [];
  private pending: Assignment[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Per-cycle recording of the world, for replaying a finished run. */
  private frames: ReturnType<Engine["liveState"]>[] = [];
  /** Smoothed real wall-clock duration of a cycle (ms) — reported to the UI for animation. */
  private measuredCycleMs: number;
  private lastCycleAt = 0;

  /** The cities this session plays, in order. Must be non-empty. */
  constructor(private legs: Leg[]) {
    if (legs.length === 0) throw new Error("a session needs at least one city");
    if (legs.length === 1) {
      this.cityId = legs[0].cityId;
      this.cityName = legs[0].cityName;
    } else {
      this.cityId = "gauntlet";
      this.cityName = `Gauntlet · ${legs.length} cities`;
    }
    this.world = new World(this.cfg);
    this.snapshot = this.buildSnapshot();
    this.measuredCycleMs = this.cfg.cycleMs;
  }

  /** The city currently being played. */
  private get leg(): Leg {
    return this.legs[this.legIndex];
  }

  /** The resolved config of the city currently being played. */
  private get cfg(): Config {
    return this.leg.cfg;
  }

  /** Read-only access to the current leg's config (for archiving). */
  get config(): Config {
    return this.cfg;
  }

  /** The world snapshot for the matcher, augmented with this session's gauntlet context. */
  private buildSnapshot(): WorldSnapshot {
    return {
      ...this.world.snapshot(),
      leg: this.legIndex + 1,
      totalLegs: this.legs.length,
      cityId: this.leg.cityId,
      cityName: this.leg.cityName,
    };
  }

  start(): void {
    if (this.status === "running") return;
    this.reset();
    this.status = "running";
    // An initial step so the first requests get generated
    this.world.step();
    this.snapshot = this.buildSnapshot();
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
    this.legIndex = 0;
    this.finishedLegs = [];
    this.world = new World(this.cfg);
    this.snapshot = this.buildSnapshot();
    this.pending = [];
    this.frames = [];
    this.lastResult = { accepted: 0, rejected: [] };
    this.measuredCycleMs = this.cfg.cycleMs;
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
    this.timer = setTimeout(() => this.advance(), this.cfg.cycleTimeoutMs);
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
    this.snapshot = this.buildSnapshot();
    this.recordFrame(); // record this cycle for replay

    if (this.world.tick >= this.cfg.sessionTicks) {
      // The current leg is over → bank its scoreboard.
      this.finishedLegs.push({
        cityId: this.leg.cityId,
        cityName: this.leg.cityName,
        scoreboard: { ...this.world.scoreboard },
      });
      if (this.legIndex < this.legs.length - 1) {
        this.startNextLeg();
      } else {
        this.status = "finished";
        this.onFinish?.(); // whole gauntlet finished → archive the combined result
      }
    } else {
      this.armTimeout();
    }
    this.onSnapshot?.(this.snapshot, this.status); // push to matchers connected via WebSocket
  }

  /** Move to the next city: fresh world, one initial step, new snapshot — same connection. */
  private startNextLeg(): void {
    this.legIndex++;
    this.world = new World(this.cfg);
    this.world.step(); // generate the new city's first requests
    this.snapshot = this.buildSnapshot();
    this.recordFrame();
    this.armTimeout();
  }

  /** Real measured cycle duration (ms), clamped to a sane range for the UI. */
  get cycleMs(): number {
    return Math.min(2000, Math.max(50, Math.round(this.measuredCycleMs)));
  }

  /**
   * The running total across the whole gauntlet: every banked leg plus the
   * in-progress leg. Once the session is finished the current leg is already
   * banked, so it is not added a second time.
   */
  private combinedScoreboard(): Scoreboard {
    const sum = emptyScoreboard();
    for (const l of this.finishedLegs) addScoreboard(sum, l.scoreboard);
    if (this.status !== "finished") addScoreboard(sum, this.world.scoreboard);
    return sum;
  }

  /** The combined gauntlet total, with weighted averages — this is the session's score. */
  total() {
    return withAvgs(this.combinedScoreboard());
  }

  /** Per-city breakdown of the run (banked legs, plus the current leg while it's in progress). */
  legBreakdown() {
    const legs = this.finishedLegs.map((l, i) => ({
      leg: i + 1,
      cityId: l.cityId,
      cityName: l.cityName,
      scoreboard: withAvgs(l.scoreboard),
    }));
    if (this.status !== "finished") {
      legs.push({
        leg: this.legIndex + 1,
        cityId: this.leg.cityId,
        cityName: this.leg.cityName,
        scoreboard: withAvgs({ ...this.world.scoreboard }),
      });
    }
    return legs;
  }

  /**
   * The dynamic, per-tick part of the world (drivers, active trips, scoreboard).
   * This is exactly what the UI draws — so a recorded sequence of these frames
   * can be replayed later with the same renderer. Each frame is tagged with its
   * leg/city so a replay can tell when the world switched cities.
   */
  private liveState() {
    const w = this.world;
    return {
      tick: w.tick,
      minute: w.minute,
      leg: this.legIndex + 1,
      cityId: this.leg.cityId,
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
          waitedMinutes: (w.tick - t.requestedTick) * this.cfg.minutesPerTick,
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
    if (!this.cfg.recordReplays) return;
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

  /**
   * Per-leg metadata a replay needs to render each city: its world dimensions
   * (which differ per city, so the replay can rescale the map), its animation
   * step, and its final scoreboard (so the replay can show a running total).
   */
  private legMeta() {
    return this.legs.map((l, i) => ({
      leg: i + 1,
      cityId: l.cityId,
      cityName: l.cityName,
      sessionTicks: l.cfg.sessionTicks,
      stepPerCycle: l.cfg.driverSpeed * l.cfg.minutesPerTick,
      world: { width: l.cfg.worldWidth, height: l.cfg.worldHeight },
      // Final scoreboard of this leg once it has finished (null while still in progress).
      scoreboard: this.finishedLegs[i] ? withAvgs({ ...this.finishedLegs[i].scoreboard }) : null,
    }));
  }

  /** The recorded replay: per-tick frames plus the metadata the renderer needs. */
  replay() {
    return {
      creator: this.creator,
      userId: this.userId,
      cityId: this.cityId,
      cityName: this.cityName,
      // Per-leg metadata; frames carry a `leg` so the renderer picks the right world dims.
      legs: this.legMeta(),
      // Top-level defaults (first leg) for older single-world replay viewers.
      sessionTicks: this.cfg.sessionTicks,
      stepPerCycle: this.cfg.driverSpeed * this.cfg.minutesPerTick,
      world: { width: this.cfg.worldWidth, height: this.cfg.worldHeight },
      frames: this.frames,
    };
  }

  /** Full state for the UI (all drivers + active trips + scoreboard). */
  vizState() {
    return {
      creator: this.creator,
      userId: this.userId,
      status: this.status,
      sessionTicks: this.cfg.sessionTicks,
      /** Real measured cycle duration (full-speed engine), so the UI animates in sync. */
      cycleMs: this.cycleMs,
      /** Distance each driver travels in one cycle — for accurate animation prediction in the UI. */
      stepPerCycle: this.cfg.driverSpeed * this.cfg.minutesPerTick,
      world: { width: this.cfg.worldWidth, height: this.cfg.worldHeight },
      lastResult: this.lastResult,
      ...this.liveState(), // includes the current leg's `scoreboard`, `leg`, `cityId`
      // Session identity (overrides liveState's per-leg cityId) + gauntlet context.
      cityId: this.cityId,
      cityName: this.cityName,
      leg: this.legIndex + 1,
      totalLegs: this.legs.length,
      currentCityId: this.leg.cityId,
      currentCityName: this.leg.cityName,
      /** The combined total across all legs — the session's actual score. */
      total: this.total(),
      /** Per-city breakdown so the UI can show where the matcher was strong/weak. */
      legBreakdown: this.legBreakdown(),
    };
  }
}
