/*
 * Dashboard. The game runs fast and finishes almost instantly, so worlds are no
 * longer shown live — the dashboard is the scoreboard: the leaderboard everyone
 * sees, plus each player's own finished runs, each with a replay to watch.
 */

// Small fetch helper (the dashboard no longer loads render.js, which used to define this).
const api = (p, m = "GET", body) => {
  const auth = window.US_AUTH ? window.US_AUTH.header() : {};
  const headers = { ...(body ? { "Content-Type": "application/json" } : {}), ...auth };
  return fetch(p, {
    method: m,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
const fmt = (n) => Math.round(Number(n)).toLocaleString("en-US");
function when(ts) { try { return new Date(ts).toLocaleString("en-US"); } catch { return ts; } }

// A badge for the world a run played: the gauntlet, or a single city's name.
function worldBadge(r) {
  const name = r.city_name || (r.city_id === "gauntlet" ? "Gauntlet" : "Metropolis");
  const isG = r.city_id === "gauntlet";
  return `<span class="world-badge${isG ? " gauntlet" : ""}">${isG ? "🏟 " : "🌍 "}${escapeHtml(name)}</span>`;
}
function replayBtn(id) {
  return id ? `<a class="rep-btn" href="/replay.html?id=${encodeURIComponent(id)}" title="Watch replay">▶ Watch</a>` : "—";
}
function makerLink(r) {
  const name = escapeHtml(r.creator || "—");
  return r.user_id
    ? `<a class="maker-link" href="/results.html?user=${encodeURIComponent(r.user_id)}">${name}</a>`
    : name;
}

/* ---------- leaderboard (everyone's best run) ---------- */

const LB_HEAD = `<tr>
  <th class="num">#</th><th>Player</th><th>World</th>
  <th class="num">💰 Best revenue</th><th class="num">✅</th><th class="num">❌</th>
  <th class="num">⭐R</th><th class="num">⭐D</th><th class="num">Runs</th><th>Replay</th>
</tr>`;

async function loadLeaderboard() {
  const head = document.getElementById("lb-head");
  const body = document.getElementById("lb-rows");
  if (!body) return;
  head.innerHTML = LB_HEAD;
  let rows = [];
  try {
    rows = (await api("/leaderboard?limit=50")).leaderboard || [];
  } catch {
    body.innerHTML = `<tr><td colspan="10" class="tbl-empty">Engine not reachable.</td></tr>`;
    return;
  }
  body.innerHTML = rows.length
    ? rows.map((r, i) => `<tr>
        <td class="num rank">${i + 1}</td>
        <td>${makerLink(r)}</td>
        <td>${worldBadge(r)}</td>
        <td class="num">${fmt(r.revenue)}</td>
        <td class="num good">${r.completed}</td>
        <td class="num bad">${r.cancelled}</td>
        <td class="num">${Number(r.rider_avg).toFixed(2)}</td>
        <td class="num">${Number(r.driver_avg).toFixed(2)}</td>
        <td class="num runs">${r.runs ?? 1}</td>
        <td>${replayBtn(r.id)}</td>
      </tr>`).join("")
    : `<tr><td colspan="10" class="tbl-empty">No finished runs yet — run a client to get on the board.</td></tr>`;
}

/* ---------- your runs (logged-in player's finished runs + replays) ---------- */

const MY_HEAD = `<tr>
  <th class="sid">Session</th><th>World</th>
  <th class="num">💰 Revenue</th><th class="num">✅</th><th class="num">❌</th>
  <th class="num">⭐R</th><th class="num">⭐D</th><th>When</th><th>Replay</th>
</tr>`;

async function loadMyRuns() {
  const section = document.getElementById("myruns-section");
  if (!section) return;
  const loggedIn = window.US_AUTH && US_AUTH.id;
  section.style.display = loggedIn ? "" : "none";
  if (!loggedIn) return;
  const head = document.getElementById("my-head");
  const body = document.getElementById("my-rows");
  head.innerHTML = MY_HEAD;
  let rows = [];
  try {
    rows = (await api(`/results?user=${encodeURIComponent(US_AUTH.id)}&limit=50`)).results || [];
  } catch { return; }
  body.innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td class="sid">${escapeHtml(r.id)}</td>
        <td>${worldBadge(r)}</td>
        <td class="num">${fmt(r.revenue)}</td>
        <td class="num good">${r.completed}</td>
        <td class="num bad">${r.cancelled}</td>
        <td class="num">${Number(r.rider_avg).toFixed(2)}</td>
        <td class="num">${Number(r.driver_avg).toFixed(2)}</td>
        <td class="when">${when(r.finished_at)}</td>
        <td>${replayBtn(r.id)}</td>
      </tr>`).join("")
    : `<tr><td colspan="9" class="tbl-empty">You have no finished runs yet — run your matcher with your token.</td></tr>`;
}

async function loadBoard() {
  await Promise.all([loadLeaderboard(), loadMyRuns()]);
}

/* ---------- "The cities" guide section ---------- */

async function loadCities() {
  const box = document.getElementById("cities-list");
  if (!box) return;
  let cities = [], base = {};
  try {
    cities = (await api("/cities")).cities || [];
    base = (await api("/config")).config || {};
  } catch { return; }
  box.innerHTML = cities.map((c) => {
    const e = { ...base, ...c.overrides }; // effective params = base config + this city's overrides
    return `<div class="rule"><span class="k">🌍 ${escapeHtml(c.name)}</span>
      <span class="v">${escapeHtml(c.description)}<br>
      <b>${fmt(e.worldWidth)}×${fmt(e.worldHeight)}</b> map · <b>${fmt(e.driverCount)}</b> drivers ·
      ~<b>${fmt(e.riderArrivalRate)}</b> requests/cycle · <b>${e.riderPatienceMinutes} min</b> patience</span></div>`;
  }).join("");
}

if (window.US_AUTH) US_AUTH.onChange(loadBoard); // refresh "your runs" on login/logout
loadBoard();
loadCities();
setInterval(loadBoard, 4000); // runs finish quickly — keep the board fresh
