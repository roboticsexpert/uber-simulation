/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  NEAREST-TRIP MATCHER — driver-centric: each driver grabs its nearest trip ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Decision philosophy: the mirror image of nearest-driver. Here the driver is in
 * charge. We walk over the idle drivers and, for each one, hand it the closest
 * still-open trip — nothing else. No feasibility check, no rating math, no global
 * optimum. Just "give this driver the nearest trip".
 *
 * Difference from nearest-driver:  nearest-driver loops over trips and finds the
 *                                  nearest driver; this loops over drivers and
 *                                  finds the nearest trip. Same distance metric,
 *                                  opposite point of view (which side gets to pick).
 *
 * Run:  MATCHER_NAME="NearestTrip" npm run client:nearest-trip
 *       BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:nearest-trip
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

/** ----- Core logic: for each driver, take the nearest open trip ----- */
function decide(state: State): Assignment[] {
  const assignments: Assignment[] = [];
  const openIds = new Set(state.openRequests.map((r) => r.id));
  const byId = new Map(state.openRequests.map((r) => [r.id, r]));

  for (const driver of state.idleDrivers) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const id of openIds) {
      const d = dist(driver.pos, byId.get(id)!.origin);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best) {
      assignments.push({ driverId: driver.id, tripId: best });
      openIds.delete(best); // a trip can be taken by only one driver this cycle.
    }
  }
  return assignments;
}
/** ------------------------------------------------------------------- */

async function ensureSession(): Promise<string> {
  if (process.env.SESSION_ID) return process.env.SESSION_ID;
  const name = (process.env.MATCHER_NAME ?? "NearestTrip").trim();
  if (!name) {
    console.error('❌ MATCHER_NAME is required. Example:  MATCHER_NAME="Team Alpha" npm run client:nearest-trip');
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

  ws.addEventListener("open", () => console.log(`📍 NEAREST-TRIP connected to ${session} — each driver takes its nearest trip`));
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
