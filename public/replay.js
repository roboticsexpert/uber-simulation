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

function buildWorld(frame) {
  return {
    id: RID,
    world: meta.world,
    stepPerCycle: meta.stepPerCycle,
    cycleMs: frameDur(),
    sessionTicks: meta.sessionTicks,
    creator: meta.creator,
    tick: frame.tick,
    minute: frame.minute,
    drivers: frame.drivers,
    trips: frame.trips,
    scoreboard: frame.scoreboard,
  };
}

/** Drop the renderer's interpolation state for our world so the next frame snaps cleanly (used on seek). */
function clearAnim() {
  for (const k in anim) if (k.startsWith(RID + ":")) delete anim[k];
  delete lastTick[RID];
}

function enterFrame(i, snap) {
  idx = Math.max(0, Math.min(frames.length - 1, i));
  if (snap) clearAnim();
  world = buildWorld(frames[idx]);
  setupAnim(world); // interpolate toward this frame (snaps if we just cleared)
  frameStart = performance.now();
  updatePanel();
}

function updatePanel() {
  const f = frames[idx];
  const sb = f.scoreboard;
  setText("creator", meta.creator || "—");
  setText("tick", `${f.tick} / ${meta.sessionTicks}`);
  setText("minute", f.minute);
  setText("completed", sb.completed);
  setText("cancelled", sb.cancelled);
  setText("riderAvg", sb.riderAvg.toFixed(2));
  setText("driverAvg", sb.driverAvg.toFixed(2));
  setText("revenue", Math.round(sb.revenue));
  const seek = el("seek");
  seek.value = String(idx);
  setText("time", `${f.tick} / ${meta.sessionTicks}`);
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
  meta = { creator: r.creator, world: r.world, stepPerCycle: r.stepPerCycle, sessionTicks: r.sessionTicks };
  frames = r.frames || [];
  if (!frames.length) { document.getElementById("title").textContent = "▶ Replay — empty recording"; return; }
  document.getElementById("title").textContent = "▶ " + (meta.creator ? meta.creator + " · " : "") + ID;
  el("seek").max = String(frames.length - 1);
  enterFrame(0, true);
  setPlaying(true); // autoplay
}
load();
