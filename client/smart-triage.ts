/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SMART-TRIAGE MATCHER — smart's optimal brain + triage's "no doomed rides" ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This is `smart` with the triage rule baked in, permanently and without exceptions:
 *   ▸ If a driver cannot reach the rider before their patience runs out, the trip
 *     WILL be cancelled — so we never send that driver after them. A driver is never
 *     wasted chasing a pickup that is doomed to cancel; it stays free for a feasible
 *     rescue this cycle (or the next).
 *
 * How it keeps smart's strength while adding the triage guarantee:
 *   1) OPTIMAL MATCHING — each cycle it still solves a globally optimal assignment
 *      (max-weight bipartite matching via Hungarian / Kuhn–Munkres, O(n³)).
 *   2) STRICT FEASIBILITY — an infeasible (would-arrive-late) pair is simply not an
 *      edge in the matching. It can never be chosen, no matter what.
 *   3) NO REPOSITIONING — unlike `smart`, there is no opt-in mode that sends a driver
 *      onto a doomed trip just to relocate it. If it can't be completed, it isn't sent.
 *   4) Lexicographic value, an exact mirror of the engine's score: coverage ≫ rating ≫ distance.
 *
 * Difference from smart:   smart can (optionally, via REPOSITION) dispatch a driver to a
 *                          trip it cannot complete, to nudge its position. smart-triage never does.
 * Difference from triage:  triage is a single-pass greedy EDF; smart-triage is the global
 *                          optimum over only the feasible pairs.
 *
 * Run:
 *   MATCHER_NAME="SmartTriage" npm run client:smart-triage
 *   BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:smart-triage
 *   DASHBOARD=0 npm run client:smart-triage        # simple log mode (no map)
 *
 * Tune with env: COMPLETION_BONUS, W_RIDER, W_DRIVER, W_DIST, URGENCY_W
 */

import WebSocket from "ws";

// ─────────────────────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────────────────────
const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const WS_BASE = BASE.replace(/^http/, "ws");
const TOKEN = (process.env.TOKEN ?? "").trim();
if (!TOKEN) {
  console.error("❌ TOKEN is required. Register on the website to get your API token, then run with TOKEN=your_api_token");
  process.exit(1);
}
const DASHBOARD = process.env.DASHBOARD !== "0" && !!process.stdout.isTTY;

/**
 * The value function, lexicographic (hierarchical): coverage ≫ urgency ≫ rating ≫ distance.
 * The completion bonus must be large enough that no other term sacrifices the "number of completions"
 * (hard lesson: if COMPLETION_BONUS is small, W_DIST·D swallows it and coverage breaks).
 */
const COMPLETION_BONUS = num("COMPLETION_BONUS", 1e6); // the pure value of completing one trip (absolute dominant)
/**
 * URGENCY_W — the priority weight for the longest-waiting request.
 * Empirically proven to **hurt** under contention: chasing about-to-expire requests
 * means low rating and tied-up drivers; it is better to serve fresh requests quickly
 * (low wait ⇒ high rating ⇒ for both rider and driver). Default = 0 (off).
 */
const URGENCY_W = num("URGENCY_W", 0);
const W_RIDER = num("W_RIDER", 100); // rider rating weight (secondary criterion after coverage)
const W_DRIVER = num("W_DRIVER", 100); // driver rating weight
const CANCEL_PENALTY = num("CANCEL_PENALTY", 2); // only for estimating the score in the dashboard
/**
 * W_DIST — the weight of the pickup-distance penalty in the value of a feasible assignment.
 * The key to throughput: a nearer driver frees up faster ⇒ more trips over the whole game.
 * A larger value = a stronger priority for the nearest driver (and consequently better rating).
 */
const W_DIST = num("W_DIST", 1.0);

function num(name: string, def: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? def : Number(v);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Types (the shape of the WebSocket and viz messages)
// ─────────────────────────────────────────────────────────────────────────────
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
  id?: string;
  status: string;
  tick: number;
  minute: number;
  sessionTicks: number;
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

interface VizState {
  status: string;
  tick: number;
  sessionTicks: number;
  world: { width: number; height: number };
  drivers: { id: string; pos: Vec2; state: string; tripId: string | null }[];
  trips: { id: string; origin: Vec2; destination: Vec2; state: string }[];
  scoreboard: {
    completed: number;
    cancelled: number;
    riderRatingSum: number;
    riderRatingCount: number;
    driverRatingSum: number;
    driverRatingCount: number;
    revenue: number;
    riderAvg: number;
    driverAvg: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Geometry and scoring — an exact mirror of src/geometry.ts
// ─────────────────────────────────────────────────────────────────────────────
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** Rating from minutes — exactly matching the engine: <1→5, ≤2→4, ≤3→3, ≤4→2, more→1 */
function ratingFromMinutes(m: number): number {
  if (m < 1) return 5;
  if (m <= 2) return 4;
  if (m <= 3) return 3;
  if (m <= 4) return 2;
  return 1;
}

interface PairValue {
  value: number;
  rRider: number;
  rDriver: number;
  ticks: number;
  dist: number;
}

/**
 * The value of matching driver d to request r. If it is "infeasible" (the driver does not arrive
 * before cancellation) it returns null so it is never proposed at all — this IS the triage rule.
 *
 *   step    = the distance unit per tick = driverSpeed × minutesPerTick
 *   ticks   = the number of ticks until arrival = ceil(D / step)  (at least 1, because pickup does
 *             not happen in the same cycle we assign in; it arrives one step later)
 *   The rider cancels if its wait exceeds the patience limit. The last tick before pickup
 *   that is still ASSIGNED has waited = waitedMinutes + (ticks-1)·mpt ⇒ must be ≤ patience.
 *   Driver rating = a function of the arrival time (ticks·mpt).
 *   Rider rating = a function of the total wait = waitedMinutes + ticks·mpt.
 */
function pairValue(
  d: IdleDriver,
  r: OpenRequest,
  step: number,
  patience: number,
  mpt: number,
): PairValue | null {
  const D = dist(d.pos, r.origin);
  const ticks = Math.max(1, Math.ceil(D / step));
  // Feasibility condition — if it arrives late, the rider cancels beforehand ⇒ never send the driver.
  if (r.waitedMinutes + (ticks - 1) * mpt > patience + 1e-9) return null;

  const driverArrivalMin = ticks * mpt;
  const riderWaitMin = r.waitedMinutes + ticks * mpt;
  const rDriver = ratingFromMinutes(driverArrivalMin);
  const rRider = ratingFromMinutes(riderWaitMin);
  const value =
    COMPLETION_BONUS +
    URGENCY_W * r.waitedMinutes +
    W_RIDER * rRider +
    W_DRIVER * rDriver -
    W_DIST * D;
  return { value, rRider, rDriver, ticks, dist: D };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The Hungarian (Kuhn–Munkres) algorithm — optimal min-cost assignment on a square matrix
//  O(n³). The potentials version (e-maxx). Requires n ≤ m; we always pad to square.
// ─────────────────────────────────────────────────────────────────────────────
function minCostAssignment(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0); // p[j] = the row matched to column j
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }

  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] > 0) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The decision brain — optimal assignment over ONLY the feasible pairs
// ─────────────────────────────────────────────────────────────────────────────
interface Decision {
  assignments: Assignment[];
  /** For the dashboard: the details of each feasible assignment in this cycle. */
  picked: { driverId: string; tripId: string; rRider: number; rDriver: number; ticks: number }[];
  idle: number;
  open: number;
  /** Requests that had no feasible driver (at risk of cancellation, deliberately left alone). */
  unreachable: number;
  /** The number of feasible assignments (actual completions). */
  served: number;
}

function decide(state: State): Decision {
  const drivers = state.idleDrivers;
  const reqs = state.openRequests;
  const empty: Decision = {
    assignments: [], picked: [], idle: drivers.length, open: reqs.length,
    unreachable: 0, served: 0,
  };
  if (drivers.length === 0 || reqs.length === 0) return empty;

  // Infer minutesPerTick from the snapshot itself (it is not directly in the snapshot).
  const mpt = state.tick > 0 ? state.minute / state.tick : 1;
  const step = state.config.driverSpeed * mpt;
  const patience = state.config.riderPatienceMinutes;

  const nD = drivers.length;
  const nR = reqs.length;
  const N = Math.max(nD, nR);

  // Value matrix:
  //   feasible    → COMPLETION_BONUS + ratings  (the only real edges)
  //   infeasible  → 0  (a dummy edge ⇒ "stay idle"; a doomed pickup is NEVER an option)
  // max-weight matching ⇒ min-cost with cost = -value. The Hungarian picks the optimal set
  // of feasible assignments and leaves every infeasible/idle pairing on a zero (dummy) edge.
  const cost: number[][] = [];
  const detail: (PairValue | null)[][] = [];
  let reachableReqs = 0;
  const reqHasOption = new Array<boolean>(nR).fill(false);

  for (let i = 0; i < N; i++) {
    cost[i] = new Array<number>(N).fill(0);
    detail[i] = new Array<PairValue | null>(N).fill(null);
    for (let j = 0; j < N; j++) {
      if (i < nD && j < nR) {
        const pv = pairValue(drivers[i], reqs[j], step, patience, mpt);
        if (pv) {
          cost[i][j] = -pv.value;
          detail[i][j] = pv;
          if (!reqHasOption[j]) { reqHasOption[j] = true; reachableReqs++; }
        } else {
          cost[i][j] = 0; // infeasible → doomed ride → dummy edge, never assigned.
        }
      } else {
        cost[i][j] = 0; // dummy edge.
      }
    }
  }

  const rowToCol = minCostAssignment(cost);

  const assignments: Assignment[] = [];
  const picked: Decision["picked"] = [];
  let served = 0;
  for (let i = 0; i < nD; i++) {
    const j = rowToCol[i];
    if (j < 0 || j >= nR) continue;
    const pv = detail[i][j];
    if (!pv) continue; // only feasible pairs are ever dispatched.
    assignments.push({ driverId: drivers[i].id, tripId: reqs[j].id });
    picked.push({
      driverId: drivers[i].id, tripId: reqs[j].id,
      rRider: pv.rRider, rDriver: pv.rDriver, ticks: pv.ticks,
    });
    served++;
  }

  return {
    assignments, picked,
    idle: nD, open: nR,
    unreachable: nR - reachableReqs,
    served,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Terminal utilities (ANSI / truecolor)
// ─────────────────────────────────────────────────────────────────────────────
const E = "\x1b[";
const RESET = E + "0m";
const BOLD = E + "1m";
const DIM = E + "2m";
const fg = (r: number, g: number, b: number) => `${E}38;2;${r};${g};${b}m`;
const HIDE_CUR = E + "?25l";
const SHOW_CUR = E + "?25h";
const HOME = E + "H";
const CLR_EOL = E + "K";
const CLR_DOWN = E + "J";

// Palette
const C = {
  ink: fg(226, 232, 240),
  dim: fg(100, 116, 139),
  accent: fg(56, 189, 248), // blue
  good: fg(74, 222, 128), // green
  warn: fg(250, 204, 21), // yellow
  bad: fg(248, 113, 113), // red
  purple: fg(167, 139, 250),
  driver: fg(56, 189, 248),
  onTrip: fg(74, 222, 128),
  offline: fg(71, 85, 105),
  req: fg(250, 204, 21),
};

const visLen = (s: string) => s.replace(/\x1b\[[0-9;?]*m/g, "").length;
function pad(s: string, w: number): string {
  const l = visLen(s);
  return l >= w ? s : s + " ".repeat(w - l);
}
function bar(frac: number, width: number, color: string): string {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * width);
  return color + "█".repeat(full) + C.dim + "░".repeat(width - full) + RESET;
}
const SPARK = "▁▂▃▄▅▆▇█";
function sparkline(arr: number[], width: number): string {
  const a = arr.slice(-width);
  if (a.length === 0) return "";
  const max = Math.max(1, ...a);
  return a.map((x) => SPARK[Math.min(7, Math.floor((x / max) * 7.999))]).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Dashboard
// ─────────────────────────────────────────────────────────────────────────────
const MW = 56; // map width (characters)
const MH = 20; // map height (lines)

interface Telemetry {
  sessionId: string;
  assignHistory: number[]; // the number of assignments per cycle (for the sparkline)
  reqHistory: number[];
  totalAssigned: number;
  myRiderSum: number;
  myRiderN: number;
  myDriverSum: number;
  myDriverN: number;
  lostToUnreachable: number;
}

function renderDashboard(
  state: State,
  viz: VizState | null,
  d: Decision,
  t: Telemetry,
): string {
  const W = state.config.worldWidth || 100;
  const H = state.config.worldHeight || 100;

  // ── Map grid ──
  type Cell = { ch: string; color: string; pr: number };
  const grid: Cell[][] = Array.from({ length: MH }, () =>
    Array.from({ length: MW }, () => ({ ch: "·", color: C.dim, pr: 0 })),
  );
  const put = (p: Vec2, ch: string, color: string, pr: number) => {
    const col = Math.max(0, Math.min(MW - 1, Math.floor((p.x / W) * MW)));
    const row = Math.max(0, Math.min(MH - 1, Math.floor((p.y / H) * MH)));
    if (pr >= grid[row][col].pr) grid[row][col] = { ch, color, pr };
  };

  // Drivers: if we have viz, show all with their state, otherwise only the idle ones from the snapshot.
  if (viz) {
    for (const dr of viz.drivers) {
      if (dr.state === "IDLE") put(dr.pos, "•", C.driver, 1);
      else if (dr.state === "ON_TRIP") put(dr.pos, "▸", C.onTrip, 2);
      else put(dr.pos, "×", C.offline, 1);
    }
  } else {
    for (const dr of state.idleDrivers) put(dr.pos, "•", C.driver, 1);
  }

  // Open requests: color based on urgency (near the patience limit → red).
  const patience = state.config.riderPatienceMinutes;
  for (const r of state.openRequests) {
    const urgency = r.waitedMinutes / Math.max(1, patience);
    const col = urgency >= 0.8 ? C.bad : urgency >= 0.5 ? C.warn : C.req;
    put(r.origin, "◆", col, 3);
  }
  // This cycle's assignments: highlight the driver and the origin.
  const pickedReq = new Set(d.picked.map((p) => p.tripId));
  const pickedDrv = new Set(d.picked.map((p) => p.driverId));
  for (const r of state.openRequests) if (pickedReq.has(r.id)) put(r.origin, "◎", C.good, 5);
  for (const dr of state.idleDrivers) if (pickedDrv.has(dr.id)) put(dr.pos, "★", C.good, 6);

  // ── Header and progress ──
  const prog = state.sessionTicks ? state.tick / state.sessionTicks : 0;
  const lines: string[] = [];
  const title = `${BOLD}${C.accent}╔═ SMART-TRIAGE ${C.dim}» ${C.ink}${t.sessionId}${RESET}`;
  lines.push(title);
  lines.push(
    `${C.dim}║ tick ${C.ink}${String(state.tick).padStart(3)}${C.dim}/${state.sessionTicks}  ` +
      bar(prog, 22, C.accent) +
      ` ${C.ink}${(prog * 100).toFixed(0)}%${RESET}`,
  );

  // ── Body: map (left) + stats panel (right) ──
  const sb = viz?.scoreboard;
  const avg = (sum: number, n: number) => (n ? sum / n : 0);

  const panel: string[] = [];
  panel.push(`${BOLD}${C.purple}── this cycle ──${RESET}`);
  panel.push(`${C.dim}open requests ${C.ink}${pad(String(d.open), 4)}${C.dim}idle ${C.ink}${d.idle}`);
  panel.push(`${C.good}feasible served ${BOLD}${pad(String(d.served), 3)}${RESET}`);
  const urgentLost = d.unreachable;
  panel.push(
    `${urgentLost ? C.warn : C.dim}driverless  ${pad(String(urgentLost), 4)}${RESET}`,
  );
  const cycR = avg(d.picked.reduce((s, p) => s + p.rRider, 0), d.picked.length);
  const cycD = avg(d.picked.reduce((s, p) => s + p.rDriver, 0), d.picked.length);
  panel.push(`${C.dim}this cycle's assignment rating:`);
  panel.push(`  ${C.ink}rider  ${bar(cycR / 5, 10, C.warn)} ${cycR.toFixed(2)}`);
  panel.push(`  ${C.ink}driver ${bar(cycD / 5, 10, C.accent)} ${cycD.toFixed(2)}`);
  panel.push("");
  panel.push(`${BOLD}${C.purple}── total (real scoreboard) ──${RESET}`);
  if (sb) {
    panel.push(`${C.good}✓ completed ${BOLD}${pad(String(sb.completed), 5)}${RESET}${C.bad}✗ cancelled ${sb.cancelled}${RESET}`);
    panel.push(`${C.ink}rider ⭐ ${bar(sb.riderAvg / 5, 10, C.warn)} ${sb.riderAvg.toFixed(2)}`);
    panel.push(`${C.ink}driver⭐ ${bar(sb.driverAvg / 5, 10, C.accent)} ${sb.driverAvg.toFixed(2)}`);
    panel.push(`${C.dim}revenue  ${C.ink}${sb.revenue.toFixed(0)}`);
    const score = sb.riderRatingSum + sb.driverRatingSum - CANCEL_PENALTY * sb.cancelled;
    const total = sb.completed + sb.cancelled;
    const compRate = total ? sb.completed / total : 0;
    panel.push(`${C.dim}completion rate ${bar(compRate, 10, C.good)} ${(compRate * 100).toFixed(0)}%`);
    panel.push(`${BOLD}${C.purple}score≈ ${C.ink}${score.toFixed(0)}${RESET} ${C.dim}(=Σrating−${CANCEL_PENALTY}·cancel)`);
  } else {
    panel.push(`${C.dim}(waiting for /viz…)`);
  }
  panel.push("");
  panel.push(`${C.dim}assign/cycle ${C.accent}${sparkline(t.assignHistory, 22)}`);
  panel.push(`${C.dim}open/cycle   ${C.warn}${sparkline(t.reqHistory, 22)}`);

  // ── Laying out the map and panel side by side ──
  const top = `${C.dim}╠${"═".repeat(MW)}╦══════════════════════════════╗${RESET}`;
  lines.push(top);
  for (let row = 0; row < MH; row++) {
    let mapRow = "";
    for (let col = 0; col < MW; col++) {
      const cell = grid[row][col];
      mapRow += cell.color + cell.ch + RESET;
    }
    const side = panel[row] ?? "";
    lines.push(`${C.dim}║${RESET}${mapRow}${C.dim}║${RESET} ${pad(side, 30)}${C.dim}║${RESET}`);
  }
  lines.push(`${C.dim}╚${"═".repeat(MW)}╩══════════════════════════════╝${RESET}`);

  // ── Legend ──
  lines.push(
    `${C.driver}• idle ${C.onTrip}▸ on-trip ${C.offline}× offline ` +
      `${C.req}◆ req ${C.bad}◆ urgent ${C.good}★ assigned${RESET}`,
  );

  // Clean each line with CLR_EOL so leftovers from the previous frame are cleared.
  return HOME + lines.map((l) => l + CLR_EOL).join("\n") + "\n" + CLR_DOWN;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Simple mode (no TTY)
// ─────────────────────────────────────────────────────────────────────────────
function logCompact(state: State, d: Decision): void {
  console.log(
    `tick ${String(state.tick).padStart(3)}/${state.sessionTicks} │ ` +
      `${d.open} req, ${d.idle} idle → ${d.served} served (feasible-only)`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Startup and connection
// ─────────────────────────────────────────────────────────────────────────────
async function ensureSession(): Promise<string> {
  const fromEnv = process.env.SESSION_ID;
  if (fromEnv) return fromEnv;
  const name = (process.env.MATCHER_NAME ?? "SmartTriage").trim();
  if (!name) {
    console.error('❌ MATCHER_NAME is required. Example:  MATCHER_NAME="Team Alpha" npm run client:smart-triage');
    process.exit(1);
  }
  const r = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ name }),
  }).then((x) => x.json());
  return r.id as string;
}

async function fetchViz(id: string): Promise<VizState | null> {
  try {
    const r = await fetch(`${BASE}/sessions/${id}/viz`);
    if (!r.ok) return null;
    return (await r.json()) as VizState;
  } catch {
    return null;
  }
}

function restoreTerminal(): void {
  if (DASHBOARD) process.stdout.write(SHOW_CUR + RESET + "\n");
}

async function run(): Promise<void> {
  const session = await ensureSession();
  const telemetry: Telemetry = {
    sessionId: session,
    assignHistory: [],
    reqHistory: [],
    totalAssigned: 0,
    myRiderSum: 0, myRiderN: 0,
    myDriverSum: 0, myDriverN: 0,
    lostToUnreachable: 0,
  };

  if (DASHBOARD) process.stdout.write(HIDE_CUR + E + "2J");
  else {
    console.log(`🚀 SMART-TRIAGE is connecting to ${session}…`);
    console.log(`   Strategy: Hungarian optimal over feasible pairs only — never sends a driver on a doomed ride`);
  }

  let reconnects = 0;
  const MAX_RECONNECT = 5;

  const connect = () => {
    const ws = new WebSocket(`${WS_BASE}/sessions/${session}/ws?token=${encodeURIComponent(TOKEN)}`);

    ws.on("open", () => { reconnects = 0; });
    ws.on("error", (e: Error) => {
      if (!DASHBOARD) console.error("Socket error:", e?.message ?? e);
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      let state: State;
      try {
        state = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (state.status === "finished") {
        finish(session, telemetry);
        ws.close();
        return;
      }
      if (state.status !== "running") return;

      // 1) Decide and send immediately — minimum matching latency.
      const d = decide(state);
      ws.send(JSON.stringify({ tick: state.tick, assignments: d.assignments }));

      // Telemetry
      telemetry.assignHistory.push(d.assignments.length);
      telemetry.reqHistory.push(d.open);
      telemetry.totalAssigned += d.assignments.length;
      telemetry.lostToUnreachable += d.unreachable;
      for (const p of d.picked) {
        telemetry.myRiderSum += p.rRider; telemetry.myRiderN++;
        telemetry.myDriverSum += p.rDriver; telemetry.myDriverN++;
      }

      // 2) Output
      if (DASHBOARD) {
        // Best-effort fetch the real scoreboard, then render.
        fetchViz(session).then((viz) => {
          process.stdout.write(renderDashboard(state, viz, d, telemetry));
        });
      } else {
        logCompact(state, d);
      }
    });

    ws.on("close", () => {
      if (reconnects < MAX_RECONNECT) {
        reconnects++;
        setTimeout(connect, 400 * reconnects);
      }
    });
  };

  connect();
}

async function finish(session: string, t: Telemetry): Promise<void> {
  const viz = await fetchViz(session);
  restoreTerminal();
  const sb = viz?.scoreboard;
  console.log(`\n${BOLD}${C.accent}🏁 session ${session} finished.${RESET}`);
  if (sb) {
    const score = sb.riderRatingSum + sb.driverRatingSum - CANCEL_PENALTY * sb.cancelled;
    const total = sb.completed + sb.cancelled;
    console.log(`${C.good}  ✓ completed : ${sb.completed}${RESET}`);
    console.log(`${C.bad}  ✗ cancelled : ${sb.cancelled}${RESET}  ${C.dim}(${total ? ((sb.completed / total) * 100).toFixed(1) : "—"}% completion rate)`);
    console.log(`${C.warn}  ⭐ rider rating  : ${sb.riderAvg.toFixed(3)}${RESET}`);
    console.log(`${C.accent}  ⭐ driver rating : ${sb.driverAvg.toFixed(3)}${RESET}`);
    console.log(`${C.ink}  💰 revenue : ${sb.revenue.toFixed(0)}${RESET}`);
    console.log(`${BOLD}${C.purple}  ★ score ≈ ${score.toFixed(0)}${RESET}  ${C.dim}(Σrating − ${CANCEL_PENALTY}·cancel)`);
  }
  console.log(
    `${C.dim}  (matcher: ${t.totalAssigned} total assignments, ${t.lostToUnreachable} driverless requests over the game)${RESET}`,
  );
  process.exit(0);
}

process.on("SIGINT", () => { restoreTerminal(); process.exit(0); });
process.on("SIGTERM", () => { restoreTerminal(); process.exit(0); });

run().catch((e) => {
  restoreTerminal();
  console.error("Error:", e);
  process.exit(1);
});
