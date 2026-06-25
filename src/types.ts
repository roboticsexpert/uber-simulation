export interface Vec2 {
  x: number;
  y: number;
}

export type DriverState = "IDLE" | "ON_TRIP" | "OFFLINE";

export type TripState =
  | "REQUESTED" // registered, waiting for assignment
  | "ASSIGNED" // driver en route to the rider
  | "IN_TRANSIT" // rider on board, en route to destination
  | "COMPLETED"
  | "CANCELLED";

export interface Driver {
  id: string;
  pos: Vec2;
  state: DriverState;
  /** The trip currently being worked on (in ASSIGNED/ON_TRIP). */
  tripId: string | null;
  /** The last tick at which a trip was taken (basis for the sleep timer). */
  lastTripTick: number;
  /** If OFFLINE: the tick at which the driver should wake up. */
  wakeAtTick: number | null;
  /** Sum of ratings received from trips (for display). */
  ratingSum: number;
  ratingCount: number;
}

export interface Trip {
  id: string;
  riderId: string;
  origin: Vec2;
  destination: Vec2;
  state: TripState;
  requestedTick: number;
  assignedTick: number | null;
  pickedUpTick: number | null;
  completedTick: number | null;
  driverId: string | null;
  fare: number | null;
  riderRating: number | null;
  driverRating: number | null;
}

/** A snapshot of the world handed to the Matcher each cycle. */
export interface WorldSnapshot {
  tick: number;
  minute: number;
  sessionTicks: number;
  config: {
    worldWidth: number;
    worldHeight: number;
    driverSpeed: number;
    riderPatienceMinutes: number;
    baseFare: number;
    perDistanceFare: number;
  };
  idleDrivers: { id: string; pos: Vec2 }[];
  openRequests: {
    id: string;
    origin: Vec2;
    destination: Vec2;
    requestedTick: number;
    waitedMinutes: number;
  }[];
}

/** An assignment returned by the Matcher. */
export interface Assignment {
  driverId: string;
  tripId: string;
}

export interface Scoreboard {
  completed: number;
  cancelled: number;
  riderRatingSum: number;
  riderRatingCount: number;
  driverRatingSum: number;
  driverRatingCount: number;
  revenue: number;
}
