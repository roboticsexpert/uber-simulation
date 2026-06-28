/* Single-world page: shows one session full-screen. id comes from the ?id=... query. */

const ID = new URLSearchParams(location.search).get("id");
let world = null;

document.getElementById("title").textContent = "🌍 " + (ID || "—");
document.getElementById("reset").onclick = () => ID && api(`/sessions/${ID}/reset`, "POST");
document.getElementById("delete").onclick = async () => {
  if (ID) { await api(`/sessions/${ID}`, "DELETE"); location.href = "/"; }
};

const setText = (id, v) => (document.getElementById(id).textContent = v);

function frame() {
  if (world) {
    const cv = document.getElementById("canvas");
    drawWorld(cv.getContext("2d"), cv.clientWidth, cv.clientHeight, world, 1);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function updatePanel() {
  if (!world) return;
  const pill = document.getElementById("pill");
  const waiting = world.status === "idle";
  pill.textContent = waiting ? "waiting for matcher" : world.status;
  pill.className = "pill " + (waiting ? "waiting" : world.status);
  // Owner-only controls: only the user who owns this world may reset/delete it.
  const isOwner = window.US_AUTH && US_AUTH.id && world.userId === US_AUTH.id;
  const actions = document.querySelector(".actions");
  if (actions) actions.style.display = isOwner ? "" : "none";
  // A finished run has a saved recording → offer a replay link.
  const rl = document.getElementById("replaylink");
  if (rl) {
    if (world.status === "finished") { rl.style.display = ""; rl.href = "/replay.html?id=" + encodeURIComponent(ID); }
    else rl.style.display = "none";
  }
  const sb = world.scoreboard;
  setText("creator", world.creator || "—");
  setText("title", "🌍 " + (world.creator ? world.creator + " · " + ID : ID));
  setText("tick", `${world.tick} / ${world.sessionTicks}`);
  setText("minute", world.minute);
  setText("completed", sb.completed);
  setText("cancelled", sb.cancelled);
  setText("riderAvg", sb.riderAvg.toFixed(2));
  setText("driverAvg", sb.driverAvg.toFixed(2));
  setText("revenue", Math.round(sb.revenue));
}

// Poll once per simulation cycle (cycleMs). Smooth motion between polls is done
// client-side via interpolation (setupAnim), so polling faster just wastes bandwidth.
// Self-scheduling loop: the next request is sent only after the previous one
// settles, so a slow server can never make requests pile up.
async function poll() {
  if (!ID) return;
  try {
    const w = await api(`/sessions/${ID}/viz`);
    if (w.error) { document.getElementById("title").textContent = "🌍 " + ID + " — not found"; world = null; return; }
    world = w;
    setupAnim(world);
    updatePanel();
  } catch (e) { /* engine is not up */ }
  setTimeout(poll, 800);
}
poll();
