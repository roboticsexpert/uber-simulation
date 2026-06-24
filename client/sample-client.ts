/**
 * Matcher نمونه (مرجع شرکت‌کننده‌ها) — نسخهٔ WebSocket.
 *
 * به‌جای polling، یک سوکت باز می‌کند: سرور هر cycle وضعیتِ دنیا را push می‌کند،
 * کلاینت بلافاصله تخصیص‌ها را روی همان سوکت برمی‌گرداند. (بدون درخواست‌های پشت‌سرهم.)
 *
 *   - اگر SESSION_ID داده شود، به همان دنیا وصل می‌شود.
 *   - وگرنه با REST یک دنیای جدید می‌سازد، سپس سوکت را باز می‌کند.
 *
 * اجرا:  npm run client
 *        BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client
 *
 * هر شرکت‌کننده فقط تابع `decide()` را عوض می‌کند.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const WS_BASE = BASE.replace(/^http/, "ws");

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

async function main() {
  let session = process.env.SESSION_ID ?? "";
  if (!session) {
    const r = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then((x) => x.json());
    session = r.id;
    console.log(`🌍 دنیای جدید ساخته شد: ${session}`);
  }

  const ws = new WebSocket(`${WS_BASE}/sessions/${session}/ws`);

  ws.addEventListener("open", () => console.log(`🔌 سوکت به ${session} وصل شد — منتظرِ state…`));
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
      `[${session}] tick ${state.tick}: ${state.openRequests.length} درخواست، ${state.idleDrivers.length} آزاد → ${assignments.length} تخصیص`,
    );
  });
}

main();
