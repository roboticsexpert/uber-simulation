/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SMART MATCHER — یک Matcher پیشرفته برای مسابقهٔ Matching                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * جایگزینِ ارتقایافتهٔ `sample-client.ts`. همان قرارداد WebSocket، ولی مغزِ خیلی قوی‌تر.
 *
 * چرا از greedyِ نمونه بهتر است؟
 *   ۱) OPTIMAL MATCHING — به‌جای حریصانهٔ تک‌به‌تک، هر cycle یک تخصیصِ سراسریِ بهینه
 *      (max-weight bipartite matching با الگوریتم Hungarian/Kuhn–Munkres، O(n³)) حل
 *      می‌کند. وقتی راننده کمیاب است (contention) همین تفاوت همه‌چیز را عوض می‌کند.
 *   ۲) FEASIBILITY PRUNING — راننده‌ای را که قبل از سقفِ صبرِ مسافر نمی‌رسد هرگز
 *      تخصیص نمی‌دهد (تخصیصِ نشدنی = کنسلِ مسافر + هدررفتنِ راننده).
 *   ۳) ارزشِ lexicographic، آینهٔ دقیقِ امتیازِ engine: coverage ≫ rating ≫ distance.
 *      اول «تعدادِ تکمیل» را بیشینه می‌کند (بونوسِ غالب)، بعد ریتینگ، و در نهایت
 *      نزدیک‌ترین راننده را برای throughput و ریتینگِ بهتر می‌چیند.
 *   ۴) داشبوردِ زندهٔ ترمینال (نقشهٔ ASCII + آمار + scoreboard واقعی).
 *
 * بنچمارک (همان seed، ۲۴۰ cycle، در برابرِ sample-client):
 *   • config پیش‌فرضِ پروژه (راننده فراوان): ۱۰۰٪ تکمیل و صفر کنسل ⟶ نمونه ۹۹٪ با کنسل.
 *   • رژیمِ contention (راننده کمیاب): ‎+۶۹٪ تکمیلِ بیشتر، ریتینگِ مسافر ۳.۲ در برابرِ ۱.۲.
 *   تنها در یک config بسیار تُنُک و degenerate (≈۸۵٪ کنسل) نمونه کمی جلوتر است.
 *
 * اجرا:
 *   npm run client:smart
 *   BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client:smart
 *   DASHBOARD=0 npm run client:smart        # حالتِ لاگِ ساده (بدون نقشه)
 *
 * تیون با env: COMPLETION_BONUS, W_RIDER, W_DRIVER, W_DIST, URGENCY_W,
 *              REPOSITION (off|greedy|center), CANCEL_PENALTY
 */

import WebSocket from "ws";

// ─────────────────────────────────────────────────────────────────────────────
//  پیکربندی
// ─────────────────────────────────────────────────────────────────────────────
const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const WS_BASE = BASE.replace(/^http/, "ws");
const DASHBOARD = process.env.DASHBOARD !== "0" && !!process.stdout.isTTY;

/**
 * تابعِ ارزش، lexicographic (سلسله‌مراتبی): coverage ≫ urgency ≫ rating ≫ distance.
 * بونوسِ تکمیل باید آن‌قدر بزرگ باشد که هیچ ترمِ دیگری «تعدادِ تکمیل» را قربانی نکند
 * (درسِ سخت: اگر COMPLETION_BONUS کوچک باشد، W_DIST·D آن را می‌بلعد و coverage می‌شکند).
 */
const COMPLETION_BONUS = num("COMPLETION_BONUS", 1e6); // ارزشِ صِرفِ تکمیلِ یک سفر (غالبِ مطلق)
/**
 * URGENCY_W — وزنِ اولویتِ درخواستِ بیشتر-منتظر-مانده.
 * تجربی ثابت شد که زیرِ contention **ضرر** می‌زند: دنبالِ درخواست‌های روبه‌انقضا رفتن
 * یعنی ریتینگِ پایین و اشغالِ راننده؛ بهتر است درخواست‌های تازه را سریع سرویس کنی
 * (انتظارِ کم ⇒ ریتینگِ بالا ⇒ هم مسافر هم راننده). پیش‌فرض = ۰ (خاموش).
 */
const URGENCY_W = num("URGENCY_W", 0);
const W_RIDER = num("W_RIDER", 100); // وزنِ ریتینگِ مسافر (معیارِ ثانویه پس از coverage)
const W_DRIVER = num("W_DRIVER", 100); // وزنِ ریتینگِ راننده
const CANCEL_PENALTY = num("CANCEL_PENALTY", 2); // فقط برای تخمینِ score در داشبورد
/**
 * W_DIST — وزنِ جریمهٔ فاصلهٔ pickup در ارزشِ یک تخصیصِ feasible.
 * کلیدِ throughput: رانندهٔ نزدیک‌تر سریع‌تر آزاد می‌شود ⇒ سفرهای بیشتر در کلِ بازی.
 * مقدارِ بزرگ‌تر = اولویتِ شدیدتر به نزدیک‌ترین راننده (و در نتیجه rating بهتر).
 */
const W_DIST = num("W_DIST", 1.0);

/**
 * REPOSITIONING — کلیدِ بُردن در دنیای کرانه‌دار.
 * رانندهٔ idle خودش حرکت نمی‌کند؛ تنها راهِ جابه‌جایی‌اش، تخصیص به یک سفر است.
 * رانندگانِ بیکار را که در feasible-matching استفاده نشدند، عمداً به سمتِ تقاضا
 * (مرکزِ نقشه — جایی که بیشترین مساحتِ قابلِ‌سرویس را دارد) هل می‌دهیم. سفر کنسل
 * می‌شود ولی راننده در موقعیتِ بهتری برای cycleهای بعد رها می‌شود.
 *   "off"    → بدونِ repositioning (پیش‌فرض — با وزن‌های فعلی امن‌ترین و قوی‌ترین)
 *   "greedy" → هر درخواستِ بی‌راننده را به نزدیک‌ترین رانندهٔ آزاد بفرست (جابه‌جایی)
 *   "center" → فقط اگر راننده به مرکزِ نقشه نزدیک‌تر شود
 * نکته: با تقاضای یکنواخت و وزن‌های lexicographic، repositioning تجربی یا خنثی بود
 * یا کمی ضرر زد؛ پس به‌صورتِ آزمایشی (opt-in) نگه داشته شده و پیش‌فرض خاموش است.
 */
const REPOSITION = (process.env.REPOSITION ?? "off").toLowerCase();
const REPOSITION_WEIGHT = num("REPOSITION_WEIGHT", 0.05); // مقیاسِ ارزشِ جابه‌جایی (« COMPLETION_BONUS)

function num(name: string, def: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? def : Number(v);
}

// ─────────────────────────────────────────────────────────────────────────────
//  تایپ‌ها (شکلِ پیامِ WebSocket و viz)
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
//  هندسه و امتیاز — آینهٔ دقیقِ src/geometry.ts
// ─────────────────────────────────────────────────────────────────────────────
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** ریتینگ از روی دقیقه — عیناً مطابقِ engine: <1→5، ≤2→4، ≤3→3، ≤4→2، بیشتر→1 */
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
 * ارزشِ بستنِ راننده d به درخواستِ r. اگر «نشدنی» باشد (راننده قبل از کنسل نمی‌رسد)
 * مقدارِ null برمی‌گرداند تا اصلاً پیشنهاد نشود.
 *
 *   step    = واحدِ فاصله در هر tick = driverSpeed × minutesPerTick
 *   ticks   = تعداد tick تا رسیدن = ceil(D / step)  (حداقل ۱، چون pickup در همان
 *             cycle که تخصیص می‌دهیم رخ نمی‌دهد؛ یک step بعد می‌رسد)
 *   مسافر اگر waited از سقفِ صبر رد شود کنسل می‌کند. آخرین tickِ پیش از pickup
 *   که هنوز ASSIGNED است waited = waitedMinutes + (ticks-1)·mpt دارد ⇒ باید ≤ patience.
 *   ریتینگِ راننده = تابعِ زمانِ رسیدن (ticks·mpt).
 *   ریتینگِ مسافر = تابعِ کلِ انتظار = waitedMinutes + ticks·mpt.
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
  // شرطِ feasibility — اگر دیر برسد، مسافر قبلش کنسل می‌کند.
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

/**
 * ارزشِ repositioning برای یک جفتِ «نشدنی» (راننده به‌موقع نمی‌رسد، سفر کنسل خواهد شد).
 * راننده تا لحظهٔ کنسل به سمتِ مبدأ حرکت می‌کند و در موقعیتِ جدید رها می‌شود.
 * ارزش = مقدارِ نزدیک‌ترشدنِ راننده به مرکزِ نقشه (اگر دور شود، صفر ⇒ تخصیص نمی‌دهیم).
 */
function repositionValue(
  d: IdleDriver,
  r: OpenRequest,
  step: number,
  patience: number,
  mpt: number,
  center: Vec2,
): number {
  if (REPOSITION === "off") return 0;
  const D = dist(d.pos, r.origin);
  // تعداد stepهایی که راننده پیش از کنسل حرکت می‌کند.
  const jCancel = Math.floor((patience - r.waitedMinutes) / mpt) + 1;
  if (jCancel <= 0) return 0;
  const travel = Math.min(D, jCancel * step);
  if (REPOSITION === "greedy") {
    // مثلِ نمونه: نزدیک‌ترین راننده را بفرست (هرچه نزدیک‌تر، جذاب‌تر).
    return Math.max(0, 1000 - D) * REPOSITION_WEIGHT;
  }
  // "center": موقعیتِ راننده پس از حرکت به سمتِ مبدأ.
  const t = D > 0 ? travel / D : 0;
  const np = { x: d.pos.x + (r.origin.x - d.pos.x) * t, y: d.pos.y + (r.origin.y - d.pos.y) * t };
  const gain = dist(d.pos, center) - dist(np, center);
  return gain > 0 ? gain * REPOSITION_WEIGHT : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
//  الگوریتمِ Hungarian (Kuhn–Munkres) — تخصیصِ کم‌هزینهٔ بهینه روی ماتریسِ مربعی
//  O(n³). نسخهٔ پتانسیل‌ها (e-maxx). نیازمند n ≤ m؛ ما همیشه مربعی پَد می‌کنیم.
// ─────────────────────────────────────────────────────────────────────────────
function minCostAssignment(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0); // p[j] = ردیفِ بسته‌شده به ستونِ j
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
//  مغزِ تصمیم — تخصیصِ بهینه
// ─────────────────────────────────────────────────────────────────────────────
interface Decision {
  assignments: Assignment[];
  /** برای داشبورد: جزئیاتِ هر تخصیصِ feasibleِ این cycle. */
  picked: { driverId: string; tripId: string; rRider: number; rDriver: number; ticks: number }[];
  idle: number;
  open: number;
  /** درخواست‌هایی که هیچ رانندهٔ شدنی نداشتند (در خطرِ کنسل). */
  unreachable: number;
  /** تعدادِ تخصیصِ feasible (تکمیلِ واقعی). */
  served: number;
  /** تعدادِ رانندگانی که فقط برای repositioning فرستاده شدند. */
  repositioned: number;
}

function decide(state: State): Decision {
  const drivers = state.idleDrivers;
  const reqs = state.openRequests;
  const empty: Decision = {
    assignments: [], picked: [], idle: drivers.length, open: reqs.length,
    unreachable: 0, served: 0, repositioned: 0,
  };
  if (drivers.length === 0 || reqs.length === 0) return empty;

  // minutesPerTick را از خودِ snapshot استنتاج کن (در snapshot مستقیم نیست).
  const mpt = state.tick > 0 ? state.minute / state.tick : 1;
  const step = state.config.driverSpeed * mpt;
  const patience = state.config.riderPatienceMinutes;
  const center: Vec2 = { x: state.config.worldWidth / 2, y: state.config.worldHeight / 2 };

  const nD = drivers.length;
  const nR = reqs.length;
  const N = Math.max(nD, nR);

  // ماتریسِ ارزشِ یکپارچه:
  //   feasible    → COMPLETION_BONUS + ratings  (~۱۰۰، همیشه بر repositioning غالب)
  //   نشدنی       → ارزشِ repositioning (« COMPLETION_BONUS، فقط هل‌دادن به سمتِ مرکز)
  //   ۰           → یعنی «بیکار بمان» (یالِ dummy یا جابه‌جاییِ بی‌فایده)
  // max-weight matching ⇒ min-cost با cost = -value. یک Hungarian هر دو لایه را
  // هم‌زمان و بهینه حل می‌کند: اول همهٔ feasibleها، بعد بهترین repositioningها.
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
          // نشدنی → ارزشِ repositioning (می‌تواند ۰ باشد ⇒ مثلِ dummy، تخصیص نمی‌دهد).
          const rv = repositionValue(drivers[i], reqs[j], step, patience, mpt, center);
          cost[i][j] = -rv;
        }
      } else {
        cost[i][j] = 0; // یالِ dummy.
      }
    }
  }

  const rowToCol = minCostAssignment(cost);

  const assignments: Assignment[] = [];
  const picked: Decision["picked"] = [];
  let served = 0;
  let repositioned = 0;
  for (let i = 0; i < nD; i++) {
    const j = rowToCol[i];
    if (j < 0 || j >= nR) continue;
    const pv = detail[i][j];
    if (pv) {
      // تخصیصِ واقعی (feasible).
      assignments.push({ driverId: drivers[i].id, tripId: reqs[j].id });
      picked.push({
        driverId: drivers[i].id, tripId: reqs[j].id,
        rRider: pv.rRider, rDriver: pv.rDriver, ticks: pv.ticks,
      });
      served++;
    } else if (cost[i][j] < -1e-9) {
      // یالِ نشدنی ولی با ارزشِ repositioning مثبت ⇒ راننده را برای جابه‌جایی بفرست.
      assignments.push({ driverId: drivers[i].id, tripId: reqs[j].id });
      repositioned++;
    }
  }

  return {
    assignments, picked,
    idle: nD, open: nR,
    unreachable: nR - reachableReqs,
    served, repositioned,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ابزارِ ترمینال (ANSI / truecolor)
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

// پالت
const C = {
  ink: fg(226, 232, 240),
  dim: fg(100, 116, 139),
  accent: fg(56, 189, 248), // آبی
  good: fg(74, 222, 128), // سبز
  warn: fg(250, 204, 21), // زرد
  bad: fg(248, 113, 113), // قرمز
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
//  داشبورد
// ─────────────────────────────────────────────────────────────────────────────
const MW = 56; // عرضِ نقشه (کاراکتر)
const MH = 20; // ارتفاعِ نقشه (خط)

interface Telemetry {
  sessionId: string;
  assignHistory: number[]; // تعدادِ تخصیص در هر cycle (برای sparkline)
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

  // ── شبکهٔ نقشه ──
  type Cell = { ch: string; color: string; pr: number };
  const grid: Cell[][] = Array.from({ length: MH }, () =>
    Array.from({ length: MW }, () => ({ ch: "·", color: C.dim, pr: 0 })),
  );
  const put = (p: Vec2, ch: string, color: string, pr: number) => {
    const col = Math.max(0, Math.min(MW - 1, Math.floor((p.x / W) * MW)));
    const row = Math.max(0, Math.min(MH - 1, Math.floor((p.y / H) * MH)));
    if (pr >= grid[row][col].pr) grid[row][col] = { ch, color, pr };
  };

  // رانندگان: اگر viz داریم همه را با حالتشان نشان بده، وگرنه فقط idleهای snapshot.
  if (viz) {
    for (const dr of viz.drivers) {
      if (dr.state === "IDLE") put(dr.pos, "•", C.driver, 1);
      else if (dr.state === "ON_TRIP") put(dr.pos, "▸", C.onTrip, 2);
      else put(dr.pos, "×", C.offline, 1);
    }
  } else {
    for (const dr of state.idleDrivers) put(dr.pos, "•", C.driver, 1);
  }

  // درخواست‌های باز: رنگ بر اساسِ فوریت (نزدیکِ سقفِ صبر → قرمز).
  const patience = state.config.riderPatienceMinutes;
  for (const r of state.openRequests) {
    const urgency = r.waitedMinutes / Math.max(1, patience);
    const col = urgency >= 0.8 ? C.bad : urgency >= 0.5 ? C.warn : C.req;
    put(r.origin, "◆", col, 3);
  }
  // تخصیص‌های همین cycle: راننده و مبدأ را برجسته کن.
  const pickedReq = new Set(d.picked.map((p) => p.tripId));
  const pickedDrv = new Set(d.picked.map((p) => p.driverId));
  for (const r of state.openRequests) if (pickedReq.has(r.id)) put(r.origin, "◎", C.good, 5);
  for (const dr of state.idleDrivers) if (pickedDrv.has(dr.id)) put(dr.pos, "★", C.good, 6);

  // ── سرستون و progress ──
  const prog = state.sessionTicks ? state.tick / state.sessionTicks : 0;
  const lines: string[] = [];
  const title = `${BOLD}${C.accent}╔═ SMART MATCHER ${C.dim}» ${C.ink}${t.sessionId}${RESET}`;
  lines.push(title);
  lines.push(
    `${C.dim}║ tick ${C.ink}${String(state.tick).padStart(3)}${C.dim}/${state.sessionTicks}  ` +
      bar(prog, 22, C.accent) +
      ` ${C.ink}${(prog * 100).toFixed(0)}%${RESET}`,
  );

  // ── بدنه: نقشه (چپ) + پنل آمار (راست) ──
  const sb = viz?.scoreboard;
  const avg = (sum: number, n: number) => (n ? sum / n : 0);

  const panel: string[] = [];
  panel.push(`${BOLD}${C.purple}── این cycle ──${RESET}`);
  panel.push(`${C.dim}درخواستِ باز  ${C.ink}${pad(String(d.open), 4)}${C.dim}idle ${C.ink}${d.idle}`);
  panel.push(`${C.good}سرویسِ feasible ${BOLD}${pad(String(d.served), 3)}${RESET}`);
  panel.push(`${C.purple}↪︎ reposition  ${pad(String(d.repositioned), 3)}${RESET}`);
  const urgentLost = d.unreachable;
  panel.push(
    `${urgentLost ? C.warn : C.dim}بی‌راننده   ${pad(String(urgentLost), 4)}${RESET}`,
  );
  const cycR = avg(d.picked.reduce((s, p) => s + p.rRider, 0), d.picked.length);
  const cycD = avg(d.picked.reduce((s, p) => s + p.rDriver, 0), d.picked.length);
  panel.push(`${C.dim}ریتینگِ تخصیصِ این cycle:`);
  panel.push(`  ${C.ink}rider  ${bar(cycR / 5, 10, C.warn)} ${cycR.toFixed(2)}`);
  panel.push(`  ${C.ink}driver ${bar(cycD / 5, 10, C.accent)} ${cycD.toFixed(2)}`);
  panel.push("");
  panel.push(`${BOLD}${C.purple}── کل (scoreboard واقعی) ──${RESET}`);
  if (sb) {
    panel.push(`${C.good}✓ تکمیل   ${BOLD}${pad(String(sb.completed), 5)}${RESET}${C.bad}✗ کنسل ${sb.cancelled}${RESET}`);
    panel.push(`${C.ink}rider ⭐ ${bar(sb.riderAvg / 5, 10, C.warn)} ${sb.riderAvg.toFixed(2)}`);
    panel.push(`${C.ink}driver⭐ ${bar(sb.driverAvg / 5, 10, C.accent)} ${sb.driverAvg.toFixed(2)}`);
    panel.push(`${C.dim}درآمد    ${C.ink}${sb.revenue.toFixed(0)}`);
    const score = sb.riderRatingSum + sb.driverRatingSum - CANCEL_PENALTY * sb.cancelled;
    const total = sb.completed + sb.cancelled;
    const compRate = total ? sb.completed / total : 0;
    panel.push(`${C.dim}نرخِ تکمیل ${bar(compRate, 10, C.good)} ${(compRate * 100).toFixed(0)}%`);
    panel.push(`${BOLD}${C.purple}score≈ ${C.ink}${score.toFixed(0)}${RESET} ${C.dim}(=Σrating−${CANCEL_PENALTY}·cancel)`);
  } else {
    panel.push(`${C.dim}(در انتظارِ /viz…)`);
  }
  panel.push("");
  panel.push(`${C.dim}assign/cycle ${C.accent}${sparkline(t.assignHistory, 22)}`);
  panel.push(`${C.dim}open/cycle   ${C.warn}${sparkline(t.reqHistory, 22)}`);

  // ── چیدنِ نقشه و پنل کنار هم ──
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

  // ── راهنما ──
  lines.push(
    `${C.driver}• idle ${C.onTrip}▸ on-trip ${C.offline}× offline ` +
      `${C.req}◆ req ${C.bad}◆ urgent ${C.good}★ assigned${RESET}`,
  );

  // هر خط را با CLR_EOL تمیز کن تا باقی‌ماندهٔ فریمِ قبل پاک شود.
  return HOME + lines.map((l) => l + CLR_EOL).join("\n") + "\n" + CLR_DOWN;
}

// ─────────────────────────────────────────────────────────────────────────────
//  حالتِ ساده (بدونِ TTY)
// ─────────────────────────────────────────────────────────────────────────────
function logCompact(state: State, d: Decision): void {
  const repo = d.repositioned ? `  ↪︎${d.repositioned} reposition` : "";
  console.log(
    `tick ${String(state.tick).padStart(3)}/${state.sessionTicks} │ ` +
      `${d.open} req، ${d.idle} idle → ${d.served} سرویس${repo}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  راه‌اندازی و اتصال
// ─────────────────────────────────────────────────────────────────────────────
async function ensureSession(): Promise<string> {
  const fromEnv = process.env.SESSION_ID;
  if (fromEnv) return fromEnv;
  const name = (process.env.MATCHER_NAME ?? "").trim();
  if (!name) {
    console.error('❌ MATCHER_NAME اجباری است. مثال:  MATCHER_NAME="تیم آلفا" npm run client:smart');
    process.exit(1);
  }
  const r = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    console.log(`🚀 SMART MATCHER به ${session} وصل می‌شود…`);
    console.log(`   استراتژی: Hungarian optimal + feasibility pruning + score-aware cost`);
  }

  let reconnects = 0;
  const MAX_RECONNECT = 5;

  const connect = () => {
    const ws = new WebSocket(`${WS_BASE}/sessions/${session}/ws`);

    ws.on("open", () => { reconnects = 0; });
    ws.on("error", (e: Error) => {
      if (!DASHBOARD) console.error("خطای سوکت:", e?.message ?? e);
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

      // ۱) تصمیم بگیر و فوراً بفرست — کمترین تأخیرِ matching.
      const d = decide(state);
      ws.send(JSON.stringify({ tick: state.tick, assignments: d.assignments }));

      // تله‌متری
      telemetry.assignHistory.push(d.assignments.length);
      telemetry.reqHistory.push(d.open);
      telemetry.totalAssigned += d.assignments.length;
      telemetry.lostToUnreachable += d.unreachable;
      for (const p of d.picked) {
        telemetry.myRiderSum += p.rRider; telemetry.myRiderN++;
        telemetry.myDriverSum += p.rDriver; telemetry.myDriverN++;
      }

      // ۲) خروجی
      if (DASHBOARD) {
        // scoreboard واقعی را best-effort بگیر، بعد رندر کن.
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
  console.log(`\n${BOLD}${C.accent}🏁 session ${session} تمام شد.${RESET}`);
  if (sb) {
    const score = sb.riderRatingSum + sb.driverRatingSum - CANCEL_PENALTY * sb.cancelled;
    const total = sb.completed + sb.cancelled;
    console.log(`${C.good}  ✓ تکمیل‌شده : ${sb.completed}${RESET}`);
    console.log(`${C.bad}  ✗ کنسل‌شده  : ${sb.cancelled}${RESET}  ${C.dim}(${total ? ((sb.completed / total) * 100).toFixed(1) : "—"}% نرخِ تکمیل)`);
    console.log(`${C.warn}  ⭐ ریتینگِ مسافر  : ${sb.riderAvg.toFixed(3)}${RESET}`);
    console.log(`${C.accent}  ⭐ ریتینگِ راننده : ${sb.driverAvg.toFixed(3)}${RESET}`);
    console.log(`${C.ink}  💰 درآمد : ${sb.revenue.toFixed(0)}${RESET}`);
    console.log(`${BOLD}${C.purple}  ★ score ≈ ${score.toFixed(0)}${RESET}  ${C.dim}(Σrating − ${CANCEL_PENALTY}·cancel)`);
  }
  console.log(
    `${C.dim}  (matcher: ${t.totalAssigned} تخصیصِ کل، ${t.lostToUnreachable} درخواستِ بی‌راننده در طولِ بازی)${RESET}`,
  );
  process.exit(0);
}

process.on("SIGINT", () => { restoreTerminal(); process.exit(0); });
process.on("SIGTERM", () => { restoreTerminal(); process.exit(0); });

run().catch((e) => {
  restoreTerminal();
  console.error("خطا:", e);
  process.exit(1);
});
