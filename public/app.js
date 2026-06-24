const CAR = {
  IDLE: "#3fb950",
  ASSIGNED: "#d29922", // در راهِ رسیدن به مسافر
  IN_TRANSIT: "#58a6ff", // مسافر سوار
  OFFLINE: "#6e7681",
};
const REQ_COLOR = "#f0883e";
const DEST_COLOR = "#f85149";

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");

let snap = null; // آخرین وضعیت از /viz
let lastTick = -1;
const anim = {}; // driverId → { fx,fy,tx,ty,start,dur }
const heading = {}; // driverId → زاویهٔ فعلی (رادیان)

function fit() {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", fit);
fit();

const api = (path, method = "GET") => fetch(path, { method }).then((r) => r.json());
document.getElementById("start").onclick = () => api("/session/start", "POST").then(poll);
document.getElementById("reset").onclick = () => api("/session/reset", "POST").then(poll);
const setText = (id, v) => (document.getElementById(id).textContent = v);

// قدمِ بعدیِ ماشین، دقیقاً مثل موتور: به‌سمتِ هدف به‌اندازهٔ سرعت، ولی نه فراتر از هدف.
function stepToward(from, target, maxStep) {
  const dx = target.x - from.x, dy = target.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d <= maxStep || d === 0) return { x: target.x, y: target.y };
  const t = maxStep / d;
  return { x: from.x + dx * t, y: from.y + dy * t };
}

// موقعیتِ درون‌یابی‌شدهٔ یک راننده (مختصات دنیا)
// حرکتِ خطی با سرعت ثابت — بدون رمپِ شروع/توقف تا بین cycleها نایستد.
function worldPos(id, fallback) {
  const a = anim[id];
  if (!a) return fallback;
  const t = Math.min(1, (performance.now() - a.start) / a.dur);
  return { x: a.fx + (a.tx - a.fx) * t, y: a.fy + (a.ty - a.fy) * t };
}

/* ---------- اشکال ---------- */

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCar(x, y, angle, color, carrying) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = "#11161c";
  roundRect(-9, -10, 6, 4, 1.5); ctx.fill();
  roundRect(3, -10, 6, 4, 1.5); ctx.fill();
  roundRect(-9, 6, 6, 4, 1.5); ctx.fill();
  roundRect(3, 6, 6, 4, 1.5); ctx.fill();
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  ctx.lineWidth = 1;
  roundRect(-13, -8, 26, 16, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.55)";
  roundRect(3, -6, 6, 12, 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.18)";
  roundRect(-7, -6, 9, 12, 3); ctx.fill();
  if (carrying) {
    ctx.fillStyle = "#f0c674";
    ctx.beginPath(); ctx.arc(-3, 0, 2.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawPerson(x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  roundRect(-3.5, -2, 7, 11, 3.5); ctx.fill();
  ctx.beginPath(); ctx.arc(0, -6, 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function drawPin(x, y, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - 8, y - 9, x - 6, y - 18, x, y - 18);
  ctx.bezierCurveTo(x + 6, y - 18, x + 8, y - 9, x, y);
  ctx.fill();
  ctx.fillStyle = "#0f1419";
  ctx.beginPath(); ctx.arc(x, y - 12, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function route(a, b, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.restore();
}

/* ---------- رندر (هر فریم) ---------- */

function render() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  if (!snap) return;

  const pad = 30;
  const sx = (W - pad * 2) / snap.world.width;
  const sy = (H - pad * 2) / snap.world.height;
  const P = (p) => ({ x: pad + p.x * sx, y: pad + p.y * sy });

  ctx.strokeStyle = "#1c232d"; ctx.lineWidth = 1; ctx.setLineDash([]);
  for (let i = 0; i <= 10; i++) {
    const gx = pad + (i / 10) * (W - pad * 2);
    const gy = pad + (i / 10) * (H - pad * 2);
    ctx.beginPath(); ctx.moveTo(gx, pad); ctx.lineTo(gx, H - pad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke();
  }

  // موقعیت زندهٔ ماشین‌ها (درون‌یابی‌شده)
  const carScreen = {};
  for (const d of snap.drivers) carScreen[d.id] = P(worldPos(d.id, d.pos));
  const carrying = {};

  const waiting = [];
  for (const t of snap.trips) {
    const o = P(t.origin), dst = P(t.destination);
    if (t.state === "REQUESTED") {
      route(o, dst, REQ_COLOR, 0.25);
      drawPin(dst.x, dst.y, DEST_COLOR, 0.4);
      waiting.push(o);
    } else if (t.state === "ASSIGNED") {
      const car = carScreen[t.driverId];
      if (car) route(car, o, CAR.ASSIGNED, 0.85);
      drawPin(dst.x, dst.y, DEST_COLOR, 0.3);
      waiting.push(o);
    } else if (t.state === "IN_TRANSIT") {
      const car = carScreen[t.driverId];
      if (car) route(car, dst, CAR.IN_TRANSIT, 0.85);
      drawPin(dst.x, dst.y, DEST_COLOR, 1);
      if (t.driverId) carrying[t.driverId] = true;
    }
  }

  for (const p of waiting) drawPerson(p.x, p.y, REQ_COLOR);

  for (const d of snap.drivers) {
    const p = carScreen[d.id];
    const a = anim[d.id];
    if (a) {
      const fs = P({ x: a.fx, y: a.fy }), ts = P({ x: a.tx, y: a.ty });
      const dx = ts.x - fs.x, dy = ts.y - fs.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) heading[d.id] = Math.atan2(dy, dx);
    }
    let color = CAR.IDLE;
    if (d.state === "OFFLINE") color = CAR.OFFLINE;
    else if (d.state === "ON_TRIP") color = carrying[d.id] ? CAR.IN_TRANSIT : CAR.ASSIGNED;
    drawCar(p.x, p.y, heading[d.id] || 0, color, carrying[d.id]);
    if (d.state === "OFFLINE") {
      ctx.fillStyle = "#8b98a5"; ctx.font = "12px sans-serif";
      ctx.fillText("z", p.x + 12, p.y - 10);
    }
  }
}

function frame() { render(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);

/* ---------- پنل ---------- */

function updatePanel() {
  if (!snap) return;
  const pill = document.getElementById("status");
  pill.textContent = snap.status;
  pill.className = "pill " + snap.status;
  setText("tick", `${snap.tick} / ${snap.sessionTicks}`);
  setText("minute", snap.minute);
  setText("accepted", snap.lastResult ? snap.lastResult.accepted : 0);
  const s = snap.scoreboard;
  setText("completed", s.completed);
  setText("cancelled", s.cancelled);
  setText("riderAvg", s.riderAvg.toFixed(2));
  setText("driverAvg", s.driverAvg.toFixed(2));
  setText("revenue", Math.round(s.revenue));
  const idle = snap.drivers.filter((d) => d.state === "IDLE").length;
  const onTrip = snap.drivers.filter((d) => d.state === "ON_TRIP").length;
  const req = snap.trips.filter((t) => t.state === "REQUESTED").length;
  document.getElementById("badge").textContent =
    `🚕 ${idle} آزاد · 🛣️ ${onTrip} در سفر · 🧍 ${req} منتظر`;
}

/* ---------- poll: داده را می‌گیرد و انیمیشن را شروع می‌کند ---------- */

async function poll() {
  try {
    const s = await api("/viz");
    const tickChanged = s.tick !== lastTick;
    if (tickChanged) {
      // مدت انیمیشن = طولِ cycle تا حرکتِ تصویری دقیقاً با موتور هم‌گام باشد
      const dur = Math.max(300, s.cycleMs || 1000);
      const now = performance.now();

      const step = s.stepPerCycle || 8;

      // هدفِ راننده‌های در سفر: ASSIGNED→محل مسافر، IN_TRANSIT→مقصد
      const targets = {};
      for (const t of s.trips) {
        if (!t.driverId) continue;
        if (t.state === "ASSIGNED") targets[t.driverId] = t.origin;
        else if (t.state === "IN_TRANSIT") targets[t.driverId] = t.destination;
      }

      for (const d of s.drivers) {
        // پیش‌بینیِ موقعیتِ cycle بعد، عینِ منطقِ موتور:
        // ماشینِ در سفر به‌سمتِ هدف یک قدم می‌رود (و سرِ هدف می‌ایستد)؛ بقیه سرِ جا.
        const tg = targets[d.id];
        const pred = d.state === "ON_TRIP" && tg ? stepToward(d.pos, tg, step) : { x: d.pos.x, y: d.pos.y };
        const cur = worldPos(d.id, d.pos);
        anim[d.id] = { fx: cur.x, fy: cur.y, tx: pred.x, ty: pred.y, start: now, dur };
      }
      lastTick = s.tick;
    }
    snap = s;
    updatePanel();
  } catch (e) { /* engine هنوز بالا نیست */ }
}

setInterval(poll, 200);
poll();
