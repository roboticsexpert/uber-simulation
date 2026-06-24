/**
 * Matcher نمونه (مرجع شرکت‌کننده‌ها).
 *
 * استراتژی: حریصانه (greedy) — هر درخواست باز را به نزدیک‌ترین رانندهٔ آزاد وصل می‌کند،
 * با اولویت‌دادن به درخواست‌هایی که بیشتر منتظر مانده‌اند (تا کنسل نشوند).
 *
 * اجرا:  npm run client        یا   BASE_URL=http://host:8080 tsx client/sample-client.ts
 *
 * هر شرکت‌کننده فقط تابع `decide()` را عوض می‌کند.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:8080";

interface Vec2 { x: number; y: number; }
interface State {
  status: string;
  tick: number;
  idleDrivers: { id: string; pos: Vec2 }[];
  openRequests: { id: string; origin: Vec2; destination: Vec2; waitedMinutes: number }[];
}
interface Assignment { driverId: string; tripId: string; }

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** ----- منطق اصلی شرکت‌کننده ----- */
function decide(state: State): Assignment[] {
  const assignments: Assignment[] = [];
  const free = new Set(state.idleDrivers.map((d) => d.id));
  const byId = new Map(state.idleDrivers.map((d) => [d.id, d]));

  // فوری‌ترین درخواست‌ها اول (نزدیک به کنسل‌شدن)
  const requests = [...state.openRequests].sort((a, b) => b.waitedMinutes - a.waitedMinutes);

  for (const req of requests) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const id of free) {
      const d = dist(byId.get(id)!.pos, req.origin);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best) {
      assignments.push({ driverId: best, tripId: req.id });
      free.delete(best);
    }
  }
  return assignments;
}
/** -------------------------------- */

const get = (p: string) => fetch(BASE + p).then((r) => r.json());
const post = (p: string, body: unknown) =>
  fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

let lastTick = -1;

async function loop() {
  try {
    const state: State = await get("/state");
    if (state.status === "finished") {
      console.log("🏁 session تمام شد.");
      process.exit(0);
    }
    if (state.status === "running" && state.tick !== lastTick) {
      lastTick = state.tick;
      const assignments = decide(state);
      const res = await post("/assign", { tick: state.tick, assignments });
      console.log(
        `tick ${state.tick}: ${state.openRequests.length} درخواست، ${state.idleDrivers.length} راننده آزاد → ${assignments.length} تخصیص (${res.ok ? "ok" : res.message})`,
      );
    }
  } catch (e) {
    console.error("خطا در اتصال به engine:", (e as Error).message);
  }
}

console.log(`🤖 Matcher نمونه به ${BASE} وصل شد…`);
setInterval(loop, 500);
loop();
