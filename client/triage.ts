/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  TRIAGE MATCHER — the "emergency room" mindset (Earliest-Deadline-First)   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Decision philosophy: like a triage doctor. Each rider has a "deadline" (the
 * patience cap minus their current wait). The rider closest to canceling is
 * rescued first. But — unlike the sample greedy — we don't waste any driver on
 * a pickup that's doomed to fail: only an "on-time" (feasible) driver gets
 * assigned. If no driver can arrive in time, that request is dropped so the
 * driver stays free for a feasible rescue.
 *
 * Difference from greedy:  greedy sends the nearest driver even if they arrive
 *                          late (⟶ cancel + wasted driver). triage only commits
 *                          feasible ones.
 * Difference from smart:   smart solves a global optimum (Hungarian); triage is
 *                          a greedy EDF scheduler — simple, fast, and
 *                          cancel-averse.
 *
 * Run:  MATCHER_NAME="Triage" npm run client:triage
 *       BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:triage
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
  config: { driverSpeed: number; riderPatienceMinutes: number };
  idleDrivers: IdleDriver[];
  openRequests: OpenRequest[];
}
interface Assignment { driverId: string; tripId: string; }

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** ----- Triage logic ----- */
function decide(state: State): Assignment[] {
  const { idleDrivers, openRequests } = state;
  if (idleDrivers.length === 0 || openRequests.length === 0) return [];

  // Infer minutesPerTick from the snapshot; step = distance covered per tick.
  const mpt = state.tick > 0 ? state.minute / state.tick : 1;
  const step = state.config.driverSpeed * mpt;
  const patience = state.config.riderPatienceMinutes;

  const free = new Map(idleDrivers.map((d) => [d.id, d]));

  // EDF: least slack (closest to canceling) first. slack = patience − waited.
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
      // Does the driver arrive before the rider cancels? The last ASSIGNED tick must be ≤ patience.
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
  const name = (process.env.MATCHER_NAME ?? "Triage").trim();
  if (!name) {
    console.error('❌ MATCHER_NAME is required. Example:  MATCHER_NAME="Triage" npm run client:triage');
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

  ws.addEventListener("open", () => console.log(`🚑 TRIAGE connected to ${session} — EDF + feasibility`));
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
        `${state.openRequests.length} req, ${state.idleDrivers.length} idle → ${assignments.length} feasible rescues`,
    );
  });
}

main();
