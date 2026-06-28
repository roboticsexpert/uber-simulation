/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  NEAREST-DRIVER MATCHER — trip-centric: each trip grabs its nearest driver ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Decision philosophy: the trip is in charge. We walk over the open requests and,
 * for each one, attach the closest still-free driver — nothing else. No
 * feasibility check, no rating math, no global optimum. Just "give this trip the
 * nearest driver".
 *
 * Difference from greedy:  greedy first sorts requests by who waited longest;
 *                          here we keep the requests in their given order and only
 *                          ever ask "who is the nearest driver?".
 *
 * Run:  MATCHER_NAME="NearestDriver" npm run client:nearest-driver
 *       BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:nearest-driver
 */

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const WS_BASE = BASE.replace(/^http/, "ws");
const TOKEN = (process.env.TOKEN ?? "").trim();
if (!TOKEN) {
  console.error("❌ TOKEN is required. Register on the website to get your API token, then run with TOKEN=your_api_token");
  process.exit(1);
}

interface Vec2 { x: number; y: number; }
interface State {
  status: string;
  tick: number;
  idleDrivers: { id: string; pos: Vec2 }[];
  openRequests: { id: string; origin: Vec2; destination: Vec2; waitedMinutes: number }[];
}
interface Assignment { driverId: string; tripId: string; }

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** ----- Core logic: for each trip, take the nearest free driver ----- */
function decide(state: State): Assignment[] {
  const assignments: Assignment[] = [];
  const free = new Set(state.idleDrivers.map((d) => d.id));
  const byId = new Map(state.idleDrivers.map((d) => [d.id, d]));

  for (const req of state.openRequests) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const id of free) {
      const d = dist(byId.get(id)!.pos, req.origin);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best) {
      assignments.push({ driverId: best, tripId: req.id });
      free.delete(best); // a driver can serve only one trip this cycle.
    }
  }
  return assignments;
}
/** ------------------------------------------------------------------- */

async function ensureSession(): Promise<string> {
  if (process.env.SESSION_ID) return process.env.SESSION_ID;
  const name = (process.env.MATCHER_NAME ?? "NearestDriver").trim();
  if (!name) {
    console.error('❌ MATCHER_NAME is required. Example:  MATCHER_NAME="Team Alpha" npm run client:nearest-driver');
    process.exit(1);
  }
  const r = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ name }),
  }).then((x) => x.json());
  console.log(`🌍 New world created: ${r.id} (creator: ${name})`);
  return r.id as string;
}

async function main() {
  const session = await ensureSession();
  const ws = new WebSocket(`${WS_BASE}/sessions/${session}/ws?token=${encodeURIComponent(TOKEN)}`);

  ws.addEventListener("open", () => console.log(`📍 NEAREST-DRIVER connected to ${session} — each trip takes its nearest driver`));
  ws.addEventListener("error", (e: any) => console.error("Socket error:", e?.message ?? e));
  ws.addEventListener("close", () => console.log("Socket closed."));

  ws.addEventListener("message", (ev: any) => {
    const state: State = JSON.parse(ev.data as string);
    if (state.status === "finished") {
      console.log(`🏁 session ${session} finished.`);
      ws.close();
      process.exit(0);
    }
    if (state.status !== "running") return;
    const assignments = decide(state);
    ws.send(JSON.stringify({ tick: state.tick, assignments }));
    console.log(
      `tick ${state.tick}: ${state.openRequests.length} requests, ${state.idleDrivers.length} idle → ${assignments.length} assigned`,
    );
  });
}

main();
