/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  STABLE MATCHER — the "two-sided market" mindset (Gale–Shapley)            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Decision philosophy: instead of a central decision-maker, we run a
 * propose-and-accept market. Each request "proposes" to its nearest feasible
 * driver; each driver temporarily holds the best proposal (nearest origin, and
 * on a tie the longest-waiting rider) and rejects the rest. A rejected request
 * proposes to its next choice. This continues until stability is reached (the
 * Gale–Shapley deferred-acceptance algorithm).
 *
 * The result is a "stable matching": there is no driver-rider pair who would
 * both prefer each other over their current assignment. This differs from a
 * global greedy or a sum-optimum (Hungarian) — here the goal is
 * stability/two-sided fairness.
 *
 * Difference from smart:   smart maximizes the total value (global optimum);
 *                          stable guarantees stability, not necessarily the
 *                          maximum total.
 * Difference from triage:  triage is a single-pass EDF; stable is multi-pass
 *                          with proposal rejections and shifting holds until it
 *                          settles.
 *
 * Run:  MATCHER_NAME="Market" npm run client:stable
 *       BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:stable
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

/** ----- Stable-matching logic ----- */
function decide(state: State): Assignment[] {
  const { idleDrivers, openRequests } = state;
  if (idleDrivers.length === 0 || openRequests.length === 0) return [];

  const mpt = state.tick > 0 ? state.minute / state.tick : 1;
  const step = state.config.driverSpeed * mpt;
  const patience = state.config.riderPatienceMinutes;

  const driverPos = new Map(idleDrivers.map((d) => [d.id, d.pos]));
  const reqById = new Map(openRequests.map((r) => [r.id, r]));

  // The driver's pickup distance to a request's origin (the preference metric for both sides).
  const pickup = (driverId: string, req: OpenRequest) => dist(driverPos.get(driverId)!, req.origin);

  // Each request's preference list: only feasible drivers, ordered by proximity.
  const prefs = new Map<string, string[]>();
  for (const r of openRequests) {
    const ranked = idleDrivers
      .filter((d) => {
        const ticks = Math.max(1, Math.ceil(pickup(d.id, r) / step));
        return r.waitedMinutes + (ticks - 1) * mpt <= patience + 1e-9; // arrives in time?
      })
      .sort((a, b) => pickup(a.id, r) - pickup(b.id, r))
      .map((d) => d.id);
    prefs.set(r.id, ranked);
  }

  // A driver prefers proposal A over B if its pickup is shorter; on a tie, the
  // longer-waiting rider wins (reduces cancel risk).
  const driverPrefers = (driverId: string, challenger: OpenRequest, holder: OpenRequest): boolean => {
    const dc = pickup(driverId, challenger);
    const dh = pickup(driverId, holder);
    if (dc !== dh) return dc < dh;
    return challenger.waitedMinutes > holder.waitedMinutes;
  };

  const heldBy = new Map<string, string>(); // driverId -> tripId (temporarily held)
  const nextChoice = new Map<string, number>(); // tripId -> next index in the preference list
  const queue: string[] = openRequests.map((r) => r.id); // free requests

  while (queue.length > 0) {
    const tripId = queue.shift()!;
    const list = prefs.get(tripId)!;
    let idx = nextChoice.get(tripId) ?? 0;
    if (idx >= list.length) continue; // no feasible driver left ⟶ unassigned.

    const driverId = list[idx];
    nextChoice.set(tripId, idx + 1);

    const holder = heldBy.get(driverId);
    if (holder === undefined) {
      heldBy.set(driverId, tripId); // driver was free ⟶ hold the proposal.
    } else if (driverPrefers(driverId, reqById.get(tripId)!, reqById.get(holder)!)) {
      heldBy.set(driverId, tripId); // better proposal ⟶ reject the previous hold and requeue it.
      queue.push(holder);
    } else {
      queue.push(tripId); // driver preferred its current hold ⟶ this request moves to its next choice.
    }
  }

  const assignments: Assignment[] = [];
  for (const [driverId, tripId] of heldBy) assignments.push({ driverId, tripId });
  return assignments;
}
/** ----------------------------- */

async function ensureSession(): Promise<string> {
  if (process.env.SESSION_ID) return process.env.SESSION_ID;
  const name = (process.env.MATCHER_NAME ?? "Stable").trim();
  if (!name) {
    console.error('❌ MATCHER_NAME is required. Example:  MATCHER_NAME="Market" npm run client:stable');
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

  ws.addEventListener("open", () => console.log(`🤝 STABLE connected to ${session} — Gale–Shapley stable matching`));
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
        `${state.openRequests.length} req, ${state.idleDrivers.length} idle → ${assignments.length} stable matches`,
    );
  });
}

main();
