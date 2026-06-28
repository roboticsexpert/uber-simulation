/*
 * Replay page: loads a finished run's recording from GET /replays/:id and plays
 * it back on the same map renderer (render.js) with transport controls.
 *
 * render.js is a classic script, so its globals (drawWorld, setupAnim, anim,
 * lastTick) are visible here in the shared global scope.
 */

const ID = new URLSearchParams(location.search).get("id");
const RID = "replay-" + ID;
const BASE_MS = 700; // nominal real time per cycle at 1× speed

let meta = null;     // { creator, world, stepPerCycle, sessionTicks }
let frames = [];     // [{ tick, minute, drivers, trips, scoreboard }]
let idx = 0;
let playing = false;
let speed = 1;
let world = null;    // the object handed to drawWorld
let frameStart = 0;  // performance.now() when the current frame was entered

const el = (id) => document.getElementById(id);
const setText = (id, v) => (el(id).textContent = v);
const frameDur = () => BASE_MS / speed;

document.getElementById("title").textContent = "▶ Replay " + (ID || "—");

const totalLegs = () => (meta.legs ? meta.legs.length : 1);

/** The leg metadata for a frame (its own world size / step / city), with a fallback for old replays. */
function legMetaFor(frame) {
  const lg = frame.leg || 1;
  if (meta.legs) return meta.legs.find((l) => l.leg === lg) || meta.legs[0];
  return { leg: 1, cityId: "", cityName: "", world: meta.world, stepPerCycle: meta.stepPerCycle, sessionTicks: meta.sessionTicks, scoreboard: null };
}

function emptySb() {
  return { completed: 0, cancelled: 0, revenue: 0, riderRatingSum: 0, riderRatingCount: 0, driverRatingSum: 0, driverRatingCount: 0 };
}
function addSb(into, s) {
  if (!s) return;
  into.completed += s.completed || 0; into.cancelled += s.cancelled || 0; into.revenue += s.revenue || 0;
  into.riderRatingSum += s.riderRatingSum || 0; into.riderRatingCount += s.riderRatingCount || 0;
  into.driverRatingSum += s.driverRatingSum || 0; into.driverRatingCount += s.driverRatingCount || 0;
}
function withAvgs(s) {
  return {
    ...s,
    riderAvg: s.riderRatingCount ? s.riderRatingSum / s.riderRatingCount : 0,
    driverAvg: s.driverRatingCount ? s.driverRatingSum / s.driverRatingCount : 0,
  };
}

/** Running total at a frame: every finished prior leg's final score + this leg's in-progress score. */
function cumulativeAt(frame) {
  if (!meta.legs) return frame.scoreboard; // single-world replay: the frame's score is already the total
  const sum = emptySb();
  for (const l of meta.legs) {
    if (l.leg < (frame.leg || 1)) addSb(sum, l.scoreboard); // banked prior legs
  }
  addSb(sum, frame.scoreboard); // current leg so far
  return withAvgs(sum);
}

function buildWorld(frame) {
  const lm = legMetaFor(frame); // each city has its own map size — scale to it, not a fixed world
  return {
    id: RID,
    world: lm.world,
    stepPerCycle: lm.stepPerCycle,
    cycleMs: frameDur(),
    sessionTicks: lm.sessionTicks,
    creator: meta.creator,
    tick: frame.tick,
    minute: frame.minute,
    leg: frame.leg || 1, // lets setupAnim snap cars cleanly at a city change
    cityId: lm.cityId,
    cityName: lm.cityName,
    drivers: frame.drivers,
    trips: frame.trips,
    scoreboard: frame.scoreboard,
  };
}

/** Drop the renderer's interpolation state for our world so the next frame snaps cleanly (used on seek). */
function clearAnim() {
  for (const k in anim) if (k.startsWith(RID + ":")) delete anim[k];
  delete lastTick[RID];
  delete lastLeg[RID];
}

function enterFrame(i, snap) {
  idx = Math.max(0, Math.min(frames.length - 1, i));
  if (snap) clearAnim();
  world = buildWorld(frames[idx]);
  setupAnim(world); // interpolate toward this frame (snaps if we just cleared)
  frameStart = performance.now();
  updatePanel();
}

let shownLeg = 0; // last leg we displayed — used to flash the city-change banner

function updatePanel() {
  const f = frames[idx];
  const lm = legMetaFor(f);
  const legs = totalLegs();
  const gauntlet = legs > 1;
  // Headline numbers are the running total across cities (matches the live world view).
  const sb = cumulativeAt(f);
  setText("creator", meta.creator || "—");
  setText("tick", `${f.tick} / ${lm.sessionTicks}`);
  setText("minute", f.minute);
  setText("completed", sb.completed);
  setText("cancelled", sb.cancelled);
  setText("riderAvg", sb.riderAvg.toFixed(2));
  setText("driverAvg", sb.driverAvg.toFixed(2));
  setText("revenue", Math.round(sb.revenue));

  // City + leg progress.
  el("cityrow").style.display = gauntlet ? "" : "none";
  el("legwrap").style.display = gauntlet ? "" : "none";
  if (gauntlet) {
    setText("worldname", `${lm.cityName} · leg ${lm.leg}/${legs}`);
    let seg = "";
    for (let i = 1; i <= legs; i++) {
      const cls = i < lm.leg ? "done" : i === lm.leg ? "cur" : "";
      seg += `<i class="${cls}"></i>`;
    }
    el("legbar").innerHTML = seg;
    if (lm.leg !== shownLeg) { showCityBanner(`🌍 ${lm.cityName} · leg ${lm.leg}/${legs}`); shownLeg = lm.leg; }
  } else {
    shownLeg = 0;
  }

  const seek = el("seek");
  seek.value = String(idx);
  setText("time", gauntlet ? `leg ${lm.leg}/${legs} · ${f.tick}/${lm.sessionTicks}` : `${f.tick} / ${lm.sessionTicks}`);
}

let bannerTimer = null;
function showCityBanner(text) {
  const b = el("citybanner");
  if (!b) return;
  b.textContent = text;
  b.classList.add("show");
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove("show"), 1600);
}

function setPlaying(on) {
  // If starting from the very end, rewind first.
  if (on && idx >= frames.length - 1) enterFrame(0, true);
  playing = on;
  el("playpause").textContent = on ? "⏸" : "▶";
  frameStart = performance.now();
}

function frame() {
  if (world) {
    const cv = el("canvas");
    drawWorld(cv.getContext("2d"), cv.clientWidth, cv.clientHeight, world, 1);
  }
  if (playing && frames.length) {
    if (performance.now() - frameStart >= frameDur()) {
      if (idx < frames.length - 1) enterFrame(idx + 1);
      else setPlaying(false); // reached the end
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------- controls ---------- */
el("playpause").onclick = () => setPlaying(!playing);
el("restart").onclick = () => { enterFrame(0, true); setPlaying(true); };
el("seek").addEventListener("input", (e) => { enterFrame(Number(e.target.value), true); });
el("speed").addEventListener("change", (e) => {
  speed = Number(e.target.value) || 1;
  if (world) world.cycleMs = frameDur();
});
document.addEventListener("keydown", (e) => {
  if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
  else if (e.key === "ArrowRight") { setPlaying(false); enterFrame(idx + 1, true); }
  else if (e.key === "ArrowLeft") { setPlaying(false); enterFrame(idx - 1, true); }
});

/* ---------- load ---------- */
async function load() {
  if (!ID) { document.getElementById("title").textContent = "▶ Replay — missing id"; return; }
  let data;
  try { data = await api(`/replays/${encodeURIComponent(ID)}`); }
  catch { document.getElementById("title").textContent = "▶ Replay — engine not reachable"; return; }
  if (!data || data.error || !data.replay) {
    document.getElementById("title").textContent = "▶ Replay — not found for " + ID;
    return;
  }
  const r = data.replay;
  meta = {
    creator: r.creator,
    world: r.world,
    stepPerCycle: r.stepPerCycle,
    sessionTicks: r.sessionTicks,
    // Per-leg metadata (gauntlet replays); absent in old single-world recordings.
    legs: Array.isArray(r.legs) && r.legs.length ? r.legs : null,
  };
  frames = r.frames || [];
  if (!frames.length) { document.getElementById("title").textContent = "▶ Replay — empty recording"; return; }
  document.getElementById("title").textContent = "▶ " + (meta.creator ? meta.creator + " · " : "") + ID;
  el("seek").max = String(frames.length - 1);
  enterFrame(0, true);
  setPlaying(true); // autoplay
}
load();
