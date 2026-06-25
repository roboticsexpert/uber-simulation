/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PROFIT MATCHER — مدلِ فکری «سوداگر» (throughput / ROI)                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * فلسفهٔ تصمیم: مثلِ یک کارخانه‌دار که می‌خواهد ناوگانش بیشترین «چرخش» را داشته
 * باشد. کلیدِ بُرد در کلِ بازی این نیست که یک سفرِ تک را بهینه کنی، بلکه این است
 * که هر راننده هرچه زودتر آزاد شود تا سفرِ بعدی را بگیرد. پس هر جفتِ (راننده،
 * درخواست) با «نرخِ سود» سنجیده می‌شود:
 *
 *     rate = درآمدِ سفر ÷ (tickهای پیکاپ + tickهای خودِ سفر)
 *          = سود به ازای هر tickِ اشغالِ راننده
 *
 * سپس جفت‌ها را به ترتیبِ نزولیِ rate حریصانه برمی‌داریم (هر راننده/درخواست یک‌بار).
 * نتیجه: اولویت با سفرهایی که راننده را سریع آزاد می‌کنند و درآمدِ خوبی دارند ⟶
 * بیشترین تعدادِ سفر و درآمد در طولِ session.
 *
 * تفاوت با triage:  تریاژ دنبالِ نجاتِ فوری‌ترین مسافر است؛ profit به فوریت کاری
 *                   ندارد و دنبالِ بهره‌وریِ ناوگان است (ممکن است مسافرِ دور را رها
 *                   کند تا دو مسافرِ نزدیک را سرویس کند).
 * تفاوت با smart:   smart اول «تعدادِ تکمیل» را lexicographic بیشینه می‌کند؛
 *                   profit مستقیماً درآمد/زمانِ ناوگان را هدف می‌گیرد (حریصانه).
 *
 * اجرا:  MATCHER_NAME="سوداگر" npm run client:profit
 *        BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:profit
 */

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const WS_BASE = BASE.replace(/^http/, "ws");

interface Vec2 { x: number; y: number; }
interface IdleDriver { id: string; pos: Vec2; }
interface OpenRequest {
  id: string;
  origin: Vec2;
  destination: Vec2;
  requestedTick: number;
  waitedMinutes: number;
}
interface State {
  status: string;
  tick: number;
  minute: number;
  sessionTicks: number;
  config: {
    driverSpeed: number;
    riderPatienceMinutes: number;
    baseFare: number;
    perDistanceFare: number;
  };
  idleDrivers: IdleDriver[];
  openRequests: OpenRequest[];
}
interface Assignment { driverId: string; tripId: string; }

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** ----- منطقِ سوداگر ----- */
function decide(state: State): Assignment[] {
  const { idleDrivers, openRequests, config } = state;
  if (idleDrivers.length === 0 || openRequests.length === 0) return [];

  const mpt = state.tick > 0 ? state.minute / state.tick : 1;
  const step = config.driverSpeed * mpt;
  const patience = config.riderPatienceMinutes;

  // همهٔ جفت‌های feasible را با نرخِ سود بساز.
  interface Pair { driverId: string; tripId: string; rate: number; pickup: number; }
  const pairs: Pair[] = [];
  for (const d of idleDrivers) {
    for (const r of openRequests) {
      const Dp = dist(d.pos, r.origin);
      const pickupTicks = Math.max(1, Math.ceil(Dp / step));
      // فقط جفتِ شدنی: راننده باید پیش از کنسلِ مسافر برسد.
      if (r.waitedMinutes + (pickupTicks - 1) * mpt > patience + 1e-9) continue;

      const Dt = dist(r.origin, r.destination);
      const tripTicks = Math.max(1, Math.ceil(Dt / step));
      const revenue = config.baseFare + config.perDistanceFare * Dt;
      const busyTicks = pickupTicks + tripTicks; // مدتِ اشغالِ راننده
      pairs.push({ driverId: d.id, tripId: r.id, rate: revenue / busyTicks, pickup: Dp });
    }
  }

  // پرسودترین به ازای زمانِ ناوگان اول؛ در تساوی، پیکاپِ کوتاه‌تر (آزادسازیِ سریع‌تر).
  pairs.sort((a, b) => b.rate - a.rate || a.pickup - b.pickup);

  const usedDrivers = new Set<string>();
  const usedTrips = new Set<string>();
  const assignments: Assignment[] = [];
  for (const p of pairs) {
    if (usedDrivers.has(p.driverId) || usedTrips.has(p.tripId)) continue;
    assignments.push({ driverId: p.driverId, tripId: p.tripId });
    usedDrivers.add(p.driverId);
    usedTrips.add(p.tripId);
  }
  return assignments;
}
/** ----------------------- */

async function ensureSession(): Promise<string> {
  if (process.env.SESSION_ID) return process.env.SESSION_ID;
  const name = (process.env.MATCHER_NAME ?? "").trim();
  if (!name) {
    console.error('❌ MATCHER_NAME اجباری است. مثال:  MATCHER_NAME="سوداگر" npm run client:profit');
    process.exit(1);
  }
  const r = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((x) => x.json());
  console.log(`🌍 دنیای جدید ساخته شد: ${r.id} (سازنده: ${name})`);
  return r.id as string;
}

async function main() {
  const session = await ensureSession();
  const ws = new WebSocket(`${WS_BASE}/sessions/${session}/ws`);

  ws.addEventListener("open", () => console.log(`💰 PROFIT به ${session} وصل شد — بیشینهٔ سود/زمانِ ناوگان`));
  ws.addEventListener("error", (e: any) => console.error("خطای سوکت:", e?.message ?? e));
  ws.addEventListener("close", () => console.log("سوکت بسته شد."));

  ws.addEventListener("message", (ev: any) => {
    const state: State = JSON.parse(ev.data as string);
    if (state.status === "finished") {
      console.log(`🏁 session ${session} تمام شد.`);
      ws.close();
      process.exit(0);
    }
    if (state.status !== "running") return;
    const assignments = decide(state);
    ws.send(JSON.stringify({ tick: state.tick, assignments }));
    console.log(
      `tick ${String(state.tick).padStart(3)}/${state.sessionTicks} │ ` +
        `${state.openRequests.length} req، ${state.idleDrivers.length} idle → ${assignments.length} سفرِ پرسود`,
    );
  });
}

main();
