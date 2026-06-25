/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  TRIAGE MATCHER — مدلِ فکری «اورژانس» (Earliest-Deadline-First)            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * فلسفهٔ تصمیم: مثلِ پزشکِ تریاژ. هر مسافر یک «مهلت» دارد (سقفِ صبر منهای انتظارِ
 * فعلی). مسافری که به کنسل نزدیک‌تر است اول نجات داده می‌شود. اما — برخلافِ
 * greedyِ نمونه — هیچ راننده‌ای را روی یک پیکاپِ محکوم‌به‌شکست هدر نمی‌دهیم:
 * تنها رانندهٔ «به‌موقع‌رس» (feasible) تخصیص می‌گیرد. اگر هیچ راننده‌ای به‌موقع
 * نرسد، آن درخواست رها می‌شود تا راننده برای یک نجاتِ شدنی آزاد بماند.
 *
 * تفاوت با greedy:  greedy نزدیک‌ترین راننده را حتی اگر دیر برسد می‌فرستد
 *                   (⟶ کنسل + هدررفتِ راننده). triage فقط شدنی‌ها را می‌بندد.
 * تفاوت با smart:   smart یک بهینهٔ سراسری (Hungarian) حل می‌کند؛ triage یک
 *                   زمان‌بندِ حریصانهٔ EDF است — ساده، سریع، و کنسل‌گریز.
 *
 * اجرا:  MATCHER_NAME="تریاژ" npm run client:triage
 *        BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:triage
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
  config: { driverSpeed: number; riderPatienceMinutes: number };
  idleDrivers: IdleDriver[];
  openRequests: OpenRequest[];
}
interface Assignment { driverId: string; tripId: string; }

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** ----- منطقِ تریاژ ----- */
function decide(state: State): Assignment[] {
  const { idleDrivers, openRequests } = state;
  if (idleDrivers.length === 0 || openRequests.length === 0) return [];

  // minutesPerTick را از snapshot استنتاج کن؛ step = مسافتِ هر tick.
  const mpt = state.tick > 0 ? state.minute / state.tick : 1;
  const step = state.config.driverSpeed * mpt;
  const patience = state.config.riderPatienceMinutes;

  const free = new Map(idleDrivers.map((d) => [d.id, d]));

  // EDF: کم‌مهلت‌ترین (نزدیک‌ترین به کنسل) اول. مهلت = patience − waited.
  const reqs = [...openRequests].sort(
    (a, b) => (patience - a.waitedMinutes) - (patience - b.waitedMinutes),
  );

  const assignments: Assignment[] = [];
  for (const req of reqs) {
    let best: IdleDriver | null = null;
    let bestD = Infinity;
    for (const d of free.values()) {
      const D = dist(d.pos, req.origin);
      const ticks = Math.max(1, Math.ceil(D / step));
      // آیا راننده پیش از کنسلِ مسافر می‌رسد؟ آخرین tickِ ASSIGNED باید ≤ patience باشد.
      const feasible = req.waitedMinutes + (ticks - 1) * mpt <= patience + 1e-9;
      if (!feasible) continue;
      if (D < bestD) { bestD = D; best = d; }
    }
    if (best) {
      assignments.push({ driverId: best.id, tripId: req.id });
      free.delete(best.id);
    }
  }
  return assignments;
}
/** ---------------------- */

async function ensureSession(): Promise<string> {
  if (process.env.SESSION_ID) return process.env.SESSION_ID;
  const name = (process.env.MATCHER_NAME ?? "").trim();
  if (!name) {
    console.error('❌ MATCHER_NAME اجباری است. مثال:  MATCHER_NAME="تریاژ" npm run client:triage');
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

  ws.addEventListener("open", () => console.log(`🚑 TRIAGE به ${session} وصل شد — EDF + feasibility`));
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
        `${state.openRequests.length} req، ${state.idleDrivers.length} idle → ${assignments.length} نجاتِ شدنی`,
    );
  });
}

main();
