import { config } from "./config.js";
import { World } from "./world.js";
import type { Assignment, WorldSnapshot } from "./types.js";

export type SessionStatus = "idle" | "running" | "finished";

/**
 * مدیریت یک session: حلقهٔ cycle، زمان‌بندی، و بافر تخصیص‌ها.
 *
 * جریان هر cycle (هر `cycleMs`):
 *   1. تخصیص‌های دریافت‌شده برای snapshot فعلی اعمال می‌شوند.
 *   2. دنیا یک قدم جلو می‌رود (حرکت، pickup، کنسل، خواب، تولید درخواست).
 *   3. snapshot جدید منتشر می‌شود تا Matcher رویش کار کند.
 */
export class Engine {
  world = new World();
  status: SessionStatus = "idle";
  snapshot: WorldSnapshot = this.world.snapshot();
  lastResult: { accepted: number; rejected: string[] } = { accepted: 0, rejected: [] };
  /** نامِ سازندهٔ ماتچر — اجباری، هنگام ساختِ سشن ست می‌شود. */
  creator = "";
  /** هر cycle با snapshot جدید صدا زده می‌شود (برای push روی WebSocket). */
  onSnapshot?: (snapshot: WorldSnapshot, status: SessionStatus) => void;
  /** یک‌بار وقتی سشن به finished می‌رسد صدا زده می‌شود (برای آرشیو در دیتابیس). */
  onFinish?: () => void;

  private pending: Assignment[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.status === "running") return;
    this.reset();
    this.status = "running";
    // یک قدم اولیه تا اولین درخواست‌ها ساخته شوند
    this.world.step();
    this.snapshot = this.world.snapshot();
    this.timer = setInterval(() => this.cycle(), config.cycleMs);
  }

  /** فقط حلقهٔ cycle را متوقف می‌کند (بدون ساختِ دنیای جدید) — برای حذف/پاک‌سازیِ سشن. */
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

  /** تخصیص‌های Matcher برای snapshot جاری. آخرین POST کل مجموعه را تعیین می‌کند. */
  submitAssignments(tick: number, assignments: Assignment[]): { ok: boolean; message: string } {
    if (this.status !== "running") {
      return { ok: false, message: "session در حال اجرا نیست" };
    }
    if (tick !== this.snapshot.tick) {
      return { ok: false, message: `tick قدیمی است (الان ${this.snapshot.tick})` };
    }
    this.pending = assignments;
    return { ok: true, message: `${assignments.length} تخصیص دریافت شد` };
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
      this.onFinish?.(); // سشن تمام شد → آرشیوِ نتیجه در دیتابیس
    }
    this.onSnapshot?.(this.snapshot, this.status); // push به matcherهای متصل با WebSocket
  }

  /** وضعیت کامل برای UI (همهٔ رانندگان + سفرهای فعال + جدول امتیاز). */
  vizState() {
    const w = this.world;
    return {
      creator: this.creator,
      status: this.status,
      tick: w.tick,
      minute: w.minute,
      sessionTicks: config.sessionTicks,
      cycleMs: config.cycleMs,
      /** مسافتی که هر راننده در یک cycle طی می‌کند — برای پیش‌بینیِ دقیقِ انیمیشن در UI. */
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
