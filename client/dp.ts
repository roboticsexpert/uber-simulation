/**
 * DP MATCHER — the greedy matcher, but optimal "in total" each cycle.
 *
 * The sample `greedy.ts` decides locally: it walks the requests (longest wait first)
 * and hands each one its single nearest free driver. That choice is optimal for *that*
 * request, but it can be bad for the cycle as a whole — a driver who is the nearest
 * pick for two requests gets eaten by the first one, leaving the second with a far
 * (or no) driver.
 *
 * This matcher keeps the same spirit but replaces the brain with **Dynamic Programming**:
 * each cycle it solves the assignment as a whole and picks the combination that is best
 * *in total*, not greedily one-by-one.
 *
 *   Objective (lexicographic, exactly the greedy intent generalised to the whole cycle):
 *     1) serve as MANY requests as possible (every completion is worth a huge bonus), then
 *     2) among all maximum-coverage matchings, minimise the TOTAL pickup distance
 *        (nearer pickups ⇒ drivers free up sooner ⇒ better rating & throughput).
 *
 *   Method — bitmask DP (Held–Karp style) over the assignment problem:
 *     - For each request we keep only its K nearest *feasible* drivers (a driver who cannot
 *       reach the rider before patience runs out is never a candidate).
 *     - The union of those candidate drivers is a small "pool" of P drivers, indexed by bit.
 *     - dp[mask] = the best total value reachable using exactly the pool drivers in `mask`.
 *       We add requests one layer at a time; each request is either skipped or assigned to
 *       one of its still-free candidate bits. The optimum over all masks is the exact best
 *       combination on this candidate sub-graph.  O(requests · 2^P · K) per cycle.
 *     - To stay tractable the pool is capped at DP_MAX_BITS. The most urgent requests go
 *       into the exact DP; any that don't fit (and any DP leftovers) are mopped up with a
 *       plain greedy pass, so this matcher is never worse than the sample greedy.
 *
 * Run:  npm run client:dp
 *       BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:dp
 *
 * Tune with env:
 *   DP_CANDIDATES   candidate drivers kept per request   (default 4)
 *   DP_MAX_BITS     max drivers in the exact DP pool      (default 18 ⇒ 2^18 states)
 *   DP_FEASIBILITY  1 = drop drivers who can't arrive in   (default 1)
 *                   time, 0 = pure nearest (like greedy)
 */

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const WS_BASE = BASE.replace(/^http/, "ws");

function num(name: string, def: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? def : Number(v);
}

const K = Math.max(1, Math.floor(num("DP_CANDIDATES", 4)));
const MAX_BITS = Math.max(1, Math.floor(num("DP_MAX_BITS", 18)));
const FEASIBILITY = num("DP_FEASIBILITY", 1) !== 0;

/** Serving one request dominates any distance term, so coverage is maximised first. */
const SERVE_BONUS = 1e7;

interface Vec2 { x: number; y: number; }
interface IdleDriver { id: string; pos: Vec2; }
interface OpenRequest { id: string; origin: Vec2; destination: Vec2; waitedMinutes: number; }
interface State {
  status: string;
  tick: number;
  minute: number;
  config: {
    worldWidth: number;
    worldHeight: number;
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

interface Stats {
  assignments: Assignment[];
  served: number;     // total requests matched this cycle
  dpServed: number;   // matched by the exact DP
  greedyServed: number; // matched by the greedy mop-up pass
  open: number;
  idle: number;
}

/** ----- Core participant logic ----- */
function decide(state: State): Stats {
  const drivers = state.idleDrivers;
  const reqs = state.openRequests;
  const empty: Stats = {
    assignments: [], served: 0, dpServed: 0, greedyServed: 0,
    open: reqs.length, idle: drivers.length,
  };
  if (drivers.length === 0 || reqs.length === 0) return empty;

  // minutesPerTick isn't in the snapshot directly; infer it (minute / tick).
  const mpt = state.tick > 0 ? state.minute / state.tick : 1;
  const step = state.config.driverSpeed * mpt;
  const patience = state.config.riderPatienceMinutes;

  const feasible = (D: number, waited: number): boolean => {
    if (!FEASIBILITY) return true;
    // The driver picks up `ticks` steps from now; the last still-waiting tick is
    // waited + (ticks-1)·mpt, which must not exceed the patience limit.
    const ticks = Math.max(1, Math.ceil(D / step));
    return waited + (ticks - 1) * mpt <= patience + 1e-9;
  };

  // 1) For each request, keep its K nearest feasible drivers.
  type Cand = { driverIdx: number; dist: number };
  const reqCands: Cand[][] = reqs.map((req) => {
    const cands: Cand[] = [];
    for (let d = 0; d < drivers.length; d++) {
      const D = dist(drivers[d].pos, req.origin);
      if (feasible(D, req.waitedMinutes)) cands.push({ driverIdx: d, dist: D });
    }
    cands.sort((a, b) => a.dist - b.dist);
    return cands.slice(0, K);
  });

  // 2) Build the exact-DP pool within the bit budget. Most urgent requests (longest wait)
  //    get priority into the DP; the rest spill over to the greedy mop-up.
  const order = reqs
    .map((_, i) => i)
    .sort((a, b) => reqs[b].waitedMinutes - reqs[a].waitedMinutes);

  const driverToBit = new Map<number, number>(); // driverIdx -> pool bit
  const dpReqs: number[] = []; // request indices that fit in the exact DP

  for (const r of order) {
    if (reqCands[r].length === 0) continue; // no feasible driver this cycle
    const fresh = reqCands[r]
      .map((c) => c.driverIdx)
      .filter((di) => !driverToBit.has(di));
    if (driverToBit.size + fresh.length > MAX_BITS) continue; // doesn't fit → greedy later
    for (const di of fresh) driverToBit.set(di, driverToBit.size);
    dpReqs.push(r);
  }

  const P = driverToBit.size;
  const bitToDriver = new Array<number>(P);
  for (const [di, bit] of driverToBit) bitToDriver[bit] = di;

  // 3) Bitmask DP over dpReqs. dp[mask] = best total value using pool drivers in `mask`.
  const SIZE = 1 << P;
  const NEG = -Infinity;
  let dp = new Float64Array(SIZE).fill(NEG);
  dp[0] = 0;
  const choice: Int32Array[] = []; // choice[layer][mask] = bit chosen to reach mask, -1 = skip

  for (let layer = 0; layer < dpReqs.length; layer++) {
    const r = dpReqs[layer];
    const cand = reqCands[r].map((c) => ({
      bit: driverToBit.get(c.driverIdx)!,
      val: SERVE_BONUS - c.dist, // serve (+bonus), prefer the nearest (−distance)
    }));
    const ndp = new Float64Array(SIZE).fill(NEG);
    const ch = new Int32Array(SIZE).fill(-2); // -2 = unreached
    for (let mask = 0; mask < SIZE; mask++) {
      const cur = dp[mask];
      if (cur === NEG) continue;
      // Option A: skip this request (it may be served by the mop-up or a later cycle).
      if (cur > ndp[mask]) { ndp[mask] = cur; ch[mask] = -1; }
      // Option B: assign it to one of its still-free candidate drivers.
      for (const c of cand) {
        const b = 1 << c.bit;
        if (mask & b) continue;
        const nm = mask | b;
        const nv = cur + c.val;
        if (nv > ndp[nm]) { ndp[nm] = nv; ch[nm] = c.bit; }
      }
    }
    dp = ndp;
    choice.push(ch);
  }

  // Best terminal mask, then walk the choices back to recover the assignment.
  let bestMask = 0;
  let bestVal = NEG;
  for (let mask = 0; mask < SIZE; mask++) {
    if (dp[mask] > bestVal) { bestVal = dp[mask]; bestMask = mask; }
  }

  const assignments: Assignment[] = [];
  const usedDriver = new Set<number>();
  const servedReq = new Set<number>();
  let mask = bestMask;
  for (let layer = dpReqs.length - 1; layer >= 0; layer--) {
    const b = choice[layer][mask];
    if (b >= 0) {
      const driverIdx = bitToDriver[b];
      const r = dpReqs[layer];
      assignments.push({ driverId: drivers[driverIdx].id, tripId: reqs[r].id });
      usedDriver.add(driverIdx);
      servedReq.add(r);
      mask ^= 1 << b;
    }
  }
  const dpServed = assignments.length;

  // 4) Greedy mop-up: any still-open request (overflow + DP skips) takes its nearest free
  //    feasible driver from whatever is left. This can only add completions, so the DP
  //    matcher is never worse than the plain greedy one.
  let greedyServed = 0;
  for (const r of order) {
    if (servedReq.has(r)) continue;
    const req = reqs[r];
    let best = -1;
    let bestD = Infinity;
    for (let d = 0; d < drivers.length; d++) {
      if (usedDriver.has(d)) continue;
      const D = dist(drivers[d].pos, req.origin);
      if (!feasible(D, req.waitedMinutes)) continue;
      if (D < bestD) { bestD = D; best = d; }
    }
    if (best >= 0) {
      assignments.push({ driverId: drivers[best].id, tripId: req.id });
      usedDriver.add(best);
      servedReq.add(r);
      greedyServed++;
    }
  }

  return {
    assignments,
    served: assignments.length,
    dpServed,
    greedyServed,
    open: reqs.length,
    idle: drivers.length,
  };
}
/** -------------------------------- */

async function main() {
  let session = process.env.SESSION_ID ?? "";
  if (!session) {
    const name = (process.env.MATCHER_NAME ?? "DP").trim();
    if (!name) {
      console.error('❌ MATCHER_NAME is required. Example:  MATCHER_NAME="Team Alpha" npm run client:dp');
      process.exit(1);
    }
    const r = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((x) => x.json());
    session = r.id;
    console.log(`🌍 New world created: ${session} (creator: ${name})`);
  }

  const ws = new WebSocket(`${WS_BASE}/sessions/${session}/ws`);

  ws.addEventListener("open", () => console.log(`🔌 Socket connected to ${session} — waiting for state…`));
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
    const d = decide(state);
    ws.send(JSON.stringify({ tick: state.tick, assignments: d.assignments }));
    console.log(
      `[${session}] tick ${state.tick}: ${d.open} requests, ${d.idle} idle → ` +
        `${d.served} assigned (dp ${d.dpServed}, greedy ${d.greedyServed})`,
    );
  });
}

main();
