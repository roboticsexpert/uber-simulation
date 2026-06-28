/**
 * DP-TRIAGE MATCHER — the DP matcher, but it never grabs a trip that's doomed to cancel.
 *
 * This is `dp.ts` with a triage conscience. Two differences:
 *
 *   1) STRICT FEASIBILITY (always on, cannot be disabled).
 *      A driver who cannot reach the rider before the patience deadline is never a
 *      candidate — neither in the exact DP nor in the greedy mop-up. Assigning such a
 *      driver only burns the driver for a trip that cancels anyway (a wasted driver +
 *      a guaranteed cancellation). So if a trip is going to be cancelled, we don't take it
 *      — we leave the driver free to rescue someone we *can* save.
 *      (In plain `dp.ts` this is the default but can be turned off with DP_FEASIBILITY=0;
 *       here it is hard-wired.)
 *
 *   2) DEADLINE-AWARE TRIAGE (Earliest-Deadline-First).
 *      When drivers are scarce and we cannot serve everyone, the value function adds an
 *      urgency term so the DP rescues the riders closest to their deadline first. A fresh
 *      request (low wait) can still be served next cycle; an about-to-expire request
 *      cancels NOW if we skip it. Coverage is still maximised first (the serve bonus
 *      dominates), urgency breaks the tie over *which* equal-size subset to serve, and
 *      pickup distance is the final tie-break.
 *
 *   Objective (lexicographic):
 *     1) serve as MANY feasible requests as possible, then
 *     2) among maximum-coverage matchings, rescue the most URGENT riders, then
 *     3) minimise total pickup distance.
 *
 *   Method is identical to dp.ts: bitmask DP (Held–Karp) over the per-cycle assignment,
 *   with each request keeping only its K nearest *feasible* drivers, an exact DP over a
 *   bit-capped pool of the most urgent requests, and a greedy (still feasibility-checked)
 *   mop-up for the overflow — so it is never worse than the plain greedy matcher.
 *
 * Run:  npm run client:dp-triage
 *       BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:dp-triage
 *
 * Tune with env:
 *   DP_CANDIDATES   candidate drivers kept per request   (default 4)
 *   DP_MAX_BITS     max drivers in the exact DP pool      (default 18 ⇒ 2^18 states)
 *   DP_URGENCY      weight of the deadline term per       (default 1e5; must stay
 *                   waited-minute (rescue urgent riders)   ≪ serve bonus, ≫ distances)
 */

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const WS_BASE = BASE.replace(/^http/, "ws");
const TOKEN = (process.env.TOKEN ?? "").trim();
if (!TOKEN) {
  console.error("❌ TOKEN is required. Register on the website to get your API token, then run with TOKEN=your_api_token");
  process.exit(1);
}

function num(name: string, def: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? def : Number(v);
}

const K = Math.max(1, Math.floor(num("DP_CANDIDATES", 4)));
const MAX_BITS = Math.max(1, Math.floor(num("DP_MAX_BITS", 18)));

/** Serving one request dominates everything else, so coverage is maximised first. */
const SERVE_BONUS = 1e7;
/**
 * Urgency weight (per minute already waited). It must sit between the serve bonus and the
 * pickup distances: ≪ SERVE_BONUS (so it never sacrifices a completion) but ≫ any plausible
 * distance (world diagonal ≈ 11314), so among equal-coverage matchings the most
 * about-to-expire riders are rescued before distance is even considered.
 */
const URGENCY = num("DP_URGENCY", 1e5);

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
  doomed: number;     // open requests with no feasible driver (left to cancel, not grabbed)
  open: number;
  idle: number;
}

/** ----- Core participant logic ----- */
function decide(state: State): Stats {
  const drivers = state.idleDrivers;
  const reqs = state.openRequests;
  const empty: Stats = {
    assignments: [], served: 0, dpServed: 0, greedyServed: 0, doomed: 0,
    open: reqs.length, idle: drivers.length,
  };
  if (drivers.length === 0 || reqs.length === 0) return empty;

  // minutesPerTick isn't in the snapshot directly; infer it (minute / tick).
  const mpt = state.tick > 0 ? state.minute / state.tick : 1;
  const step = state.config.driverSpeed * mpt;
  const patience = state.config.riderPatienceMinutes;

  // STRICT feasibility — a driver who arrives after the deadline would only cause a
  // cancellation, so it is never a candidate. This is the heart of "triage".
  const feasible = (D: number, waited: number): boolean => {
    const ticks = Math.max(1, Math.ceil(D / step));
    return waited + (ticks - 1) * mpt <= patience + 1e-9;
  };

  // Per request: its value (urgency reward) and its K nearest feasible drivers.
  type Cand = { driverIdx: number; dist: number };
  const reqCands: Cand[][] = [];
  let doomed = 0;
  for (const req of reqs) {
    const cands: Cand[] = [];
    for (let d = 0; d < drivers.length; d++) {
      const D = dist(drivers[d].pos, req.origin);
      if (feasible(D, req.waitedMinutes)) cands.push({ driverIdx: d, dist: D });
    }
    cands.sort((a, b) => a.dist - b.dist);
    if (cands.length === 0) doomed++; // no one can save this rider → don't grab a driver for it
    reqCands.push(cands.slice(0, K));
  }

  // Build the exact-DP pool within the bit budget. Most urgent requests (longest wait)
  // get priority into the DP; the rest spill over to the greedy mop-up.
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

  // value of serving request r with a driver at pickup distance D:
  //   coverage bonus  +  urgency (rescue the longest-waiting)  −  distance.
  const reqValue = (r: number, D: number) =>
    SERVE_BONUS + URGENCY * reqs[r].waitedMinutes - D;

  // Bitmask DP over dpReqs. dp[mask] = best total value using pool drivers in `mask`.
  const SIZE = 1 << P;
  const NEG = -Infinity;
  let dp = new Float64Array(SIZE).fill(NEG);
  dp[0] = 0;
  const choice: Int32Array[] = []; // choice[layer][mask] = bit chosen to reach mask, -1 = skip

  for (let layer = 0; layer < dpReqs.length; layer++) {
    const r = dpReqs[layer];
    const cand = reqCands[r].map((c) => ({
      bit: driverToBit.get(c.driverIdx)!,
      val: reqValue(r, c.dist),
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

  // Greedy mop-up: any still-open request (overflow + DP skips) takes its nearest free
  // FEASIBLE driver. Still strict — a doomed trip is never grabbed here either.
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
    doomed,
    open: reqs.length,
    idle: drivers.length,
  };
}
/** -------------------------------- */

async function main() {
  let session = process.env.SESSION_ID ?? "";
  if (!session) {
    const name = (process.env.MATCHER_NAME ?? "DP-Triage").trim();
    if (!name) {
      console.error('❌ MATCHER_NAME is required. Example:  MATCHER_NAME="Team Alpha" npm run client:dp-triage');
      process.exit(1);
    }
    const r = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name }),
    }).then((x) => x.json());
    session = r.id;
    console.log(`🌍 New world created: ${session} (creator: ${name})`);
  }

  const ws = new WebSocket(`${WS_BASE}/sessions/${session}/ws?token=${encodeURIComponent(TOKEN)}`);

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
    const doomedNote = d.doomed ? `, ${d.doomed} doomed skipped` : "";
    console.log(
      `[${session}] tick ${state.tick}: ${d.open} requests, ${d.idle} idle → ` +
        `${d.served} assigned (dp ${d.dpServed}, greedy ${d.greedyServed}${doomedNote})`,
    );
  });
}

main();
