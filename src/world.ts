import type { Config } from "./config.js";
import { distance, moveToward, ratingFromMinutes } from "./geometry.js";
import type {
  Assignment,
  Driver,
  Scoreboard,
  Trip,
  Vec2,
  WorldSnapshot,
} from "./types.js";

/** Seeded RNG (mulberry32) for a reproducible scenario. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class World {
  tick = 0;
  drivers = new Map<string, Driver>();
  trips = new Map<string, Trip>();
  scoreboard: Scoreboard = {
    completed: 0,
    cancelled: 0,
    riderRatingSum: 0,
    riderRatingCount: 0,
    driverRatingSum: 0,
    driverRatingCount: 0,
    revenue: 0,
  };

  private rng: () => number;
  private nextTripId = 1;
  /** Game minutes per tick — a getter so it reads the (constructor-assigned) config. */
  private get mpt(): number {
    return this.cfg.minutesPerTick;
  }

  constructor(private cfg: Config) {
    this.rng = makeRng(cfg.seed);
    for (let i = 0; i < cfg.driverCount; i++) {
      const id = `d${i + 1}`;
      this.drivers.set(id, {
        id,
        pos: this.randomPoint(),
        state: "IDLE",
        tripId: null,
        lastTripTick: 0,
        wakeAtTick: null,
        ratingSum: 0,
        ratingCount: 0,
      });
    }
  }

  get minute(): number {
    return this.tick * this.mpt;
  }

  private randomPoint(): Vec2 {
    return {
      x: this.rng() * this.cfg.worldWidth,
      y: this.rng() * this.cfg.worldHeight,
    };
  }

  /** A Poisson sample with mean lambda (Knuth's algorithm). */
  private poisson(lambda: number): number {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.rng();
    } while (p > L);
    return k - 1;
  }

  // ---- Interface with the Matcher ----

  snapshot(): WorldSnapshot {
    const idleDrivers = [...this.drivers.values()]
      .filter((d) => d.state === "IDLE")
      .map((d) => ({ id: d.id, pos: { ...d.pos } }));

    const openRequests = [...this.trips.values()]
      .filter((t) => t.state === "REQUESTED")
      .map((t) => ({
        id: t.id,
        origin: { ...t.origin },
        destination: { ...t.destination },
        requestedTick: t.requestedTick,
        waitedMinutes: (this.tick - t.requestedTick) * this.mpt,
      }));

    return {
      tick: this.tick,
      minute: this.minute,
      sessionTicks: this.cfg.sessionTicks,
      // Single-leg defaults; the Engine overrides these with real gauntlet context.
      leg: 1,
      totalLegs: 1,
      cityId: "",
      cityName: "",
      config: {
        worldWidth: this.cfg.worldWidth,
        worldHeight: this.cfg.worldHeight,
        driverSpeed: this.cfg.driverSpeed,
        riderPatienceMinutes: this.cfg.riderPatienceMinutes,
        baseFare: this.cfg.baseFare,
        perDistanceFare: this.cfg.perDistanceFare,
      },
      idleDrivers,
      openRequests,
    };
  }

  /**
   * Applies the Matcher's assignments. Invalid assignments are silently rejected.
   * Returns: the number of accepted assignments + rejection errors.
   */
  applyAssignments(assignments: Assignment[]): { accepted: number; rejected: string[] } {
    const rejected: string[] = [];
    let accepted = 0;
    const usedDrivers = new Set<string>();

    for (const a of assignments) {
      const driver = this.drivers.get(a.driverId);
      const trip = this.trips.get(a.tripId);
      if (!driver) {
        rejected.push(`driver ${a.driverId} does not exist`);
        continue;
      }
      if (!trip) {
        rejected.push(`trip ${a.tripId} does not exist`);
        continue;
      }
      if (driver.state !== "IDLE" || usedDrivers.has(driver.id)) {
        rejected.push(`driver ${a.driverId} is not available`);
        continue;
      }
      if (trip.state !== "REQUESTED") {
        rejected.push(`trip ${a.tripId} is no longer open`);
        continue;
      }
      // valid assignment
      driver.state = "ON_TRIP";
      driver.tripId = trip.id;
      driver.lastTripTick = this.tick;
      trip.state = "ASSIGNED";
      trip.assignedTick = this.tick;
      trip.driverId = driver.id;
      usedDrivers.add(driver.id);
      accepted++;
    }
    return { accepted, rejected };
  }

  // ---- Advance one cycle ----

  step(): void {
    this.tick++;
    this.moveDrivers();
    this.processCancellations();
    this.processSleepWake();
    this.spawnRequests();
  }

  private moveDrivers(): void {
    const step = this.cfg.driverSpeed * this.mpt;
    for (const driver of this.drivers.values()) {
      if (driver.state !== "ON_TRIP" || !driver.tripId) continue;
      const trip = this.trips.get(driver.tripId);
      if (!trip) {
        driver.state = "IDLE";
        driver.tripId = null;
        continue;
      }
      const target = trip.state === "ASSIGNED" ? trip.origin : trip.destination;
      const { pos, arrived } = moveToward(driver.pos, target, step);
      driver.pos = pos;
      if (!arrived) continue;

      if (trip.state === "ASSIGNED") {
        // reached the rider → pickup + compute ratings
        trip.pickedUpTick = this.tick;
        trip.state = "IN_TRANSIT";
        const riderWait = (trip.pickedUpTick - trip.requestedTick) * this.mpt;
        const driverArrival = (trip.pickedUpTick - (trip.assignedTick ?? trip.pickedUpTick)) * this.mpt;
        trip.riderRating = ratingFromMinutes(riderWait);
        trip.driverRating = ratingFromMinutes(driverArrival);
        this.scoreboard.riderRatingSum += trip.riderRating;
        this.scoreboard.riderRatingCount++;
        this.scoreboard.driverRatingSum += trip.driverRating;
        this.scoreboard.driverRatingCount++;
        driver.ratingSum += trip.driverRating;
        driver.ratingCount++;
      } else {
        // reached the destination → end of trip
        trip.completedTick = this.tick;
        trip.state = "COMPLETED";
        trip.fare = this.cfg.baseFare + this.cfg.perDistanceFare * distance(trip.origin, trip.destination);
        this.scoreboard.completed++;
        this.scoreboard.revenue += trip.fare;
        driver.state = "IDLE";
        driver.tripId = null;
        driver.lastTripTick = this.tick;
        // a finished trip is no longer active → remove from the Map to keep the snapshot light
        this.trips.delete(trip.id);
      }
    }
  }

  private processCancellations(): void {
    const cancelled: string[] = [];
    for (const trip of this.trips.values()) {
      if (trip.state !== "REQUESTED" && trip.state !== "ASSIGNED") continue;
      const waited = (this.tick - trip.requestedTick) * this.mpt;
      if (waited <= this.cfg.riderPatienceMinutes) continue;
      // the rider ran out of patience and still hasn't been picked up → cancel
      trip.state = "CANCELLED";
      this.scoreboard.cancelled++;
      if (trip.driverId) {
        const driver = this.drivers.get(trip.driverId);
        if (driver) {
          driver.state = "IDLE";
          driver.tripId = null;
          // the driver was active, so its sleep timer stays reset
          driver.lastTripTick = this.tick;
        }
      }
      cancelled.push(trip.id);
    }
    // cancelled trips are no longer active → remove from the Map
    for (const id of cancelled) this.trips.delete(id);
  }

  private processSleepWake(): void {
    const idleLimit = this.cfg.driverIdleSleepMinutes;
    const sleepTicks = Math.round(this.cfg.driverSleepMinutes / this.mpt);
    for (const driver of this.drivers.values()) {
      if (driver.state === "IDLE") {
        const idleFor = (this.tick - driver.lastTripTick) * this.mpt;
        if (idleFor >= idleLimit) {
          driver.state = "OFFLINE";
          driver.wakeAtTick = this.tick + sleepTicks;
        }
      } else if (driver.state === "OFFLINE") {
        if (driver.wakeAtTick !== null && this.tick >= driver.wakeAtTick) {
          driver.state = "IDLE";
          driver.wakeAtTick = null;
          driver.lastTripTick = this.tick; // just woke up, so it doesn't immediately go back to sleep
        }
      }
    }
  }

  private spawnRequests(): void {
    const n = this.poisson(this.cfg.riderArrivalRate);
    for (let i = 0; i < n; i++) {
      const id = `t${this.nextTripId++}`;
      this.trips.set(id, {
        id,
        riderId: `r${this.nextTripId}`,
        origin: this.randomPoint(),
        destination: this.randomPoint(),
        state: "REQUESTED",
        requestedTick: this.tick,
        assignedTick: null,
        pickedUpTick: null,
        completedTick: null,
        driverId: null,
        fare: null,
        riderRating: null,
        driverRating: null,
      });
    }
  }
}
