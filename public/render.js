/* منطقِ مشترکِ رسم + انیمیشن — در هر دو صفحه (گرید و تک‌دنیا) استفاده می‌شود. */

const CAR = { IDLE: "#3fb950", ASSIGNED: "#d29922", IN_TRANSIT: "#58a6ff", OFFLINE: "#6e7681" };
const REQ_COLOR = "#f0883e";
const DEST_COLOR = "#f85149";

const anim = {}; // `${sid}:${did}` → { fx,fy,tx,ty,start,dur }
const heading = {};
const lastTick = {}; // sid → آخرین tick دیده‌شده

const api = (p, m = "GET", body) =>
  fetch(p, {
    method: m,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

/* ---------- درون‌یابی ---------- */

function stepToward(from, target, maxStep) {
  const dx = target.x - from.x, dy = target.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d <= maxStep || d === 0) return { x: target.x, y: target.y };
  const t = maxStep / d;
  return { x: from.x + dx * t, y: from.y + dy * t };
}
function worldPos(key, fallback) {
  const a = anim[key];
  if (!a) return fallback;
  const t = Math.min(1, (performance.now() - a.start) / a.dur);
  return { x: a.fx + (a.tx - a.fx) * t, y: a.fy + (a.ty - a.fy) * t };
}

/** با تغییرِ tick یک دنیا، هدفِ انیمیشنِ هر ماشین را (عینِ منطقِ موتور) تنظیم می‌کند. */
function setupAnim(w) {
  if (w.tick === lastTick[w.id]) return;
  lastTick[w.id] = w.tick;
  const step = w.stepPerCycle || 8;
  const dur = Math.max(300, w.cycleMs || 1000);
  const now = performance.now();
  const targets = {};
  for (const t of w.trips) {
    if (!t.driverId) continue;
    if (t.state === "ASSIGNED") targets[t.driverId] = t.origin;
    else if (t.state === "IN_TRANSIT") targets[t.driverId] = t.destination;
  }
  for (const d of w.drivers) {
    const key = w.id + ":" + d.id;
    const tg = targets[d.id];
    const pred = d.state === "ON_TRIP" && tg ? stepToward(d.pos, tg, step) : { x: d.pos.x, y: d.pos.y };
    const cur = worldPos(key, d.pos);
    anim[key] = { fx: cur.x, fy: cur.y, tx: pred.x, ty: pred.y, start: now, dur };
  }
}

/* ---------- اشکال ---------- */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawCar(ctx, x, y, angle, color, carrying, s) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.scale(s, s);
  ctx.fillStyle = "#11161c";
  roundRect(ctx, -9, -10, 6, 4, 1.5); ctx.fill();
  roundRect(ctx, 3, -10, 6, 4, 1.5); ctx.fill();
  roundRect(ctx, -9, 6, 6, 4, 1.5); ctx.fill();
  roundRect(ctx, 3, 6, 6, 4, 1.5); ctx.fill();
  ctx.fillStyle = color; ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 1;
  roundRect(ctx, -13, -8, 26, 16, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.55)"; roundRect(ctx, 3, -6, 6, 12, 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.18)"; roundRect(ctx, -7, -6, 9, 12, 3); ctx.fill();
  if (carrying) { ctx.fillStyle = "#f0c674"; ctx.beginPath(); ctx.arc(-3, 0, 2.6, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
function drawPerson(ctx, x, y, color, s) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  ctx.fillStyle = color; roundRect(ctx, -3.5, -2, 7, 11, 3.5); ctx.fill();
  ctx.beginPath(); ctx.arc(0, -6, 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}
function drawPin(ctx, x, y, color, alpha, s) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.scale(s, s);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-8, -9, -6, -18, 0, -18);
  ctx.bezierCurveTo(6, -18, 8, -9, 0, 0); ctx.fill();
  ctx.fillStyle = "#0f1419"; ctx.beginPath(); ctx.arc(0, -12, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function route(ctx, a, b, color, alpha) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore();
}

/* ---------- رسمِ یک دنیا روی یک canvas ---------- */

function drawWorld(ctx, W, H, w, iconScale) {
  const cv = ctx.canvas;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const pad = Math.max(8, W * 0.03);
  const sx = (W - pad * 2) / w.world.width;
  const sy = (H - pad * 2) / w.world.height;
  const P = (p) => ({ x: pad + p.x * sx, y: pad + p.y * sy });

  ctx.strokeStyle = "#1c232d"; ctx.lineWidth = 1; ctx.setLineDash([]);
  for (let i = 0; i <= 8; i++) {
    const gx = pad + (i / 8) * (W - pad * 2), gy = pad + (i / 8) * (H - pad * 2);
    ctx.beginPath(); ctx.moveTo(gx, pad); ctx.lineTo(gx, H - pad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke();
  }

  const carScreen = {};
  for (const d of w.drivers) carScreen[d.id] = P(worldPos(w.id + ":" + d.id, d.pos));
  const carrying = {};
  const waiting = [];
  for (const t of w.trips) {
    const o = P(t.origin), dst = P(t.destination);
    if (t.state === "REQUESTED") { route(ctx, o, dst, REQ_COLOR, 0.22); drawPin(ctx, dst.x, dst.y, DEST_COLOR, 0.4, iconScale); waiting.push(o); }
    else if (t.state === "ASSIGNED") { const c = carScreen[t.driverId]; if (c) route(ctx, c, o, CAR.ASSIGNED, 0.8); drawPin(ctx, dst.x, dst.y, DEST_COLOR, 0.3, iconScale); waiting.push(o); }
    else if (t.state === "IN_TRANSIT") { const c = carScreen[t.driverId]; if (c) route(ctx, c, dst, CAR.IN_TRANSIT, 0.8); drawPin(ctx, dst.x, dst.y, DEST_COLOR, 1, iconScale); if (t.driverId) carrying[t.driverId] = true; }
  }
  for (const p of waiting) drawPerson(ctx, p.x, p.y, REQ_COLOR, iconScale);
  for (const d of w.drivers) {
    const key = w.id + ":" + d.id, p = carScreen[d.id], a = anim[key];
    if (a) {
      const fs = P({ x: a.fx, y: a.fy }), ts = P({ x: a.tx, y: a.ty });
      if (Math.abs(ts.x - fs.x) > 0.5 || Math.abs(ts.y - fs.y) > 0.5) heading[key] = Math.atan2(ts.y - fs.y, ts.x - fs.x);
    }
    let color = CAR.IDLE;
    if (d.state === "OFFLINE") color = CAR.OFFLINE;
    else if (d.state === "ON_TRIP") color = carrying[d.id] ? CAR.IN_TRANSIT : CAR.ASSIGNED;
    drawCar(ctx, p.x, p.y, heading[key] || 0, color, carrying[d.id], iconScale);
  }
}
