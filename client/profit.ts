/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PROFIT MATCHER — the "trader" mindset (throughput / ROI)                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Decision philosophy: like a factory owner who wants the fleet to have the
 * highest "turnover". The key to winning the whole game isn't to optimize a
 * single trip, but to free each driver as soon as possible so they can pick up
 * the next trip. So each (driver, request) pair is judged by its "profit rate":
 *
 *     rate = trip revenue ÷ (pickup ticks + the trip's own ticks)
 *          = profit per tick the driver is occupied
 *
 * Then we greedily take the pairs in descending order of rate (each
 * driver/request once). Result: priority goes to trips that free the driver
 * quickly and earn good revenue ⟶ the most trips and revenue over the session.
 *
 * Difference from triage:  triage tries to rescue the most urgent rider; profit
 *                          doesn't care about urgency and chases fleet
 *                          efficiency (it may drop a faraway rider to serve two
 *                          nearby ones).
 * Difference from smart:   smart first maximizes "completion count"
 *                          lexicographically; profit directly targets
 *                          revenue/fleet-time (greedily).
 *
 * Run:  MATCHER_NAME="Profit" npm run client:profit
 *       BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:profit
 */

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const WS_BASE = BASE.replace(/^http/, "ws");
const TOKEN = (process.env.TOKEN ?? "").trim();
if (!TOKEN) {
  console.error("❌ TOKEN is required. Register on the website to get your API token, then run with TOKEN=your_api_token");
  process.exit(1);
}

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

/** ----- Trader logic ----- */
function decide(state: State): Assignment[] {
  const { idleDrivers, openRequests, config } = state;
  if (idleDrivers.length === 0 || openRequests.length === 0) return [];

  const mpt = state.tick > 0 ? state.minute / state.tick : 1;
  const step = config.driverSpeed * mpt;
  const patience = config.riderPatienceMinutes;

  // Build all feasible pairs with their profit rate.
  interface Pair { driverId: string; tripId: string; rate: number; pickup: number; }
  const pairs: Pair[] = [];
  for (const d of idleDrivers) {
    for (const r of openRequests) {
      const Dp = dist(d.pos, r.origin);
      const pickupTicks = Math.max(1, Math.ceil(Dp / step));
      // Only feasible pairs: the driver must arrive before the rider cancels.
      if (r.waitedMinutes + (pickupTicks - 1) * mpt > patience + 1e-9) continue;

      const Dt = dist(r.origin, r.destination);
      const tripTicks = Math.max(1, Math.ceil(Dt / step));
      const revenue = config.baseFare + config.perDistanceFare * Dt;
      const busyTicks = pickupTicks + tripTicks; // how long the driver is occupied
      pairs.push({ driverId: d.id, tripId: r.id, rate: revenue / busyTicks, pickup: Dp });
    }
  }

  // Most profitable per fleet-time first; on a tie, shorter pickup (faster to free up).
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
  const name = (process.env.MATCHER_NAME ?? "Profit").trim();
  if (!name) {
    console.error('❌ MATCHER_NAME is required. Example:  MATCHER_NAME="Trader" npm run client:profit');
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

  ws.addEventListener("open", () => console.log(`💰 PROFIT connected to ${session} — maximizing profit/fleet-time`));
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
      `tick ${String(state.tick).padStart(3)}/${state.sessionTicks} │ ` +
        `${state.openRequests.length} req, ${state.idleDrivers.length} idle → ${assignments.length} profitable trips`,
    );
  });
}

main();
