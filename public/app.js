/* Grid page: all worlds shown as mini-maps; click a card → its own page. */

let worlds = []; // [{id, ...vizState}]
const cardCanvas = {}; // sid → canvas

// Sessions are created only via code (an external matcher); this page is display-only.

function frame() {
  for (const w of worlds) {
    const cv = cardCanvas[w.id];
    if (cv && cv.isConnected) drawWorld(cv.getContext("2d"), cv.clientWidth, cv.clientHeight, w, 0.6);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Active (running) sessions first, then waiting/idle, then finished.
const STATUS_RANK = { running: 0, idle: 1, finished: 2 };
function sortedWorlds() {
  return worlds.slice().sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 1, rb = STATUS_RANK[b.status] ?? 1;
    if (ra !== rb) return ra - rb;
    return (b.scoreboard?.completed || 0) - (a.scoreboard?.completed || 0); // busier first
  });
}

function syncCards() {
  const grid = document.getElementById("grid");
  const empty = grid.querySelector(".empty");
  if (empty && worlds.length) empty.remove();

  const title = document.getElementById("worlds-title");
  if (title) title.style.display = worlds.length ? "" : "none";

  const ids = new Set(worlds.map((w) => w.id));
  for (const id of Object.keys(cardCanvas)) {
    if (!ids.has(id)) {
      const el = document.getElementById("card-" + id);
      if (el) el.remove();
      delete cardCanvas[id];
    }
  }
  for (const w of sortedWorlds()) {
    let el = document.getElementById("card-" + w.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "card"; el.id = "card-" + w.id;
      el.innerHTML = `<canvas></canvas><div class="card-foot">
        <span class="cid"></span>
        <span class="cmaker"></span>
        <span class="cstat"></span><span style="flex:1"></span>
        <span class="pill idle"></span></div>`;
      // click → its own page
      el.onclick = () => { window.location.href = "/world.html?id=" + encodeURIComponent(w.id); };
      grid.appendChild(el);
      cardCanvas[w.id] = el.querySelector("canvas");
    }
    const sb = w.scoreboard;
    el.querySelector(".cid").textContent = w.creator || "—";
    el.querySelector(".cmaker").textContent = w.id;
    el.querySelector(".cstat").textContent = `✅${sb.completed} ❌${sb.cancelled} ⭐${sb.riderAvg.toFixed(1)}`;
    const pill = el.querySelector(".pill");
    const waiting = w.status === "idle";
    pill.textContent = waiting ? "waiting for matcher" : w.status;
    pill.className = "pill " + (waiting ? "waiting" : w.status);
    grid.appendChild(el); // re-append in sorted order (active first)
  }
  if (worlds.length === 0 && !grid.querySelector(".empty")) {
    grid.innerHTML = `<div class="empty">No worlds yet. Sessions are created from code — run a sample client (Node.js or Python) to connect a matcher.</div>`;
  }
}

// Poll once per simulation cycle (cycleMs). Smooth motion between polls is done
// client-side via interpolation (setupAnim), so polling faster just wastes bandwidth.
// Self-scheduling loop: each request is sent only after the previous one settles,
// so a slow server can never make requests pile up.
// Fill the "World parameters" section on the landing page with live config values.
// Runs once: these are fixed for the engine's lifetime.
async function loadWorldParams() {
  let c;
  try { c = (await api("/config")).config; } catch { return; }
  if (!c) return;
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const crossCycles = Math.round(c.worldWidth / c.driverSpeed); // cycles to drive across the map's width
  set("cfg-map", `<b>${fmt(c.worldWidth)} × ${fmt(c.worldHeight)}</b> distance units — a square world. Driver positions and trip distances are measured in these units.`);
  set("cfg-speed", `<b>${fmt(c.driverSpeed)} units</b> per game-minute (i.e. per cycle) — roughly <b>${crossCycles} cycles</b> to drive all the way across the map.`);
  set("cfg-drivers", `<b>${fmt(c.driverCount)}</b> drivers. After <b>${c.driverIdleSleepMinutes} min</b> with no trip they sleep, then wake <b>${c.driverSleepMinutes} min</b> later.`);
  set("cfg-demand", `~<b>${fmt(c.riderArrivalRate)}</b> new requests per cycle (Poisson). A rider waits at most <b>${c.riderPatienceMinutes} min</b> for pickup.`);
}
loadWorldParams();

async function poll() {
  try {
    const r = await api("/sessions");
    worlds = r.sessions || [];
    for (const w of worlds) setupAnim(w);
    syncCards();
  } catch (e) { /* engine is not up */ }
  setTimeout(poll, 800);
}
poll();
