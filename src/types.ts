export interface Vec2 {
  x: number;
  y: number;
}

export type DriverState = "IDLE" | "ON_TRIP" | "OFFLINE";

export type TripState =
  | "REQUESTED" // ثبت شده، منتظر تخصیص
  | "ASSIGNED" // راننده در مسیر رسیدن به مسافر
  | "IN_TRANSIT" // مسافر سوار، در مسیر مقصد
  | "COMPLETED"
  | "CANCELLED";

export interface Driver {
  id: string;
  pos: Vec2;
  state: DriverState;
  /** سفری که الان رویش کار می‌کند (در ASSIGNED/ON_TRIP). */
  tripId: string | null;
  /** آخرین tick ای که سفری گرفت (مبنای تایمر خواب). */
  lastTripTick: number;
  /** اگر OFFLINE: tick ای که باید بیدار شود. */
  wakeAtTick: number | null;
  /** مجموع رِیتینگ‌هایی که از سفرها گرفته (برای نمایش). */
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

/** تصویری از دنیا که در هر cycle به Matcher داده می‌شود. */
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

/** یک تخصیص که Matcher برمی‌گرداند. */
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
