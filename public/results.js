/*
 * Results page. Three views:
 *   - leaderboard : one row per player (their best run), ranked by revenue
 *   - all         : every finished session, public — anyone can see all submissions
 *   - me / user   : a single player's runs (their personal scoreboard)
 */

const fmt = (n) => Math.round(Number(n)).toLocaleString("en-US");
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function when(ts) {
  try { return new Date(ts).toLocaleString("en-US"); } catch { return ts; }
}

const params = new URLSearchParams(location.search);
let view = params.get("me") ? "me"
  : params.get("user") ? "user"
  : params.get("all") ? "all"
  : "leaderboard";
const userParam = params.get("user") || "";

const HEAD_LEADERBOARD = `<tr>
  <th class="num">#</th><th>Player</th><th>World</th>
  <th class="num">💰 Best revenue</th><th class="num">✅ Completed</th><th class="num">❌ Cancelled</th>
  <th class="num">⭐ Rider</th><th class="num">⭐ Driver</th><th class="num">Runs</th>
</tr>`;
const HEAD_RUNS = `<tr>
  <th class="num">#</th><th>Player</th><th class="sid">Session</th><th>World</th>
  <th class="num">💰 Revenue</th><th class="num">✅ Completed</th><th class="num">❌ Cancelled</th>
  <th class="num">⭐ Rider</th><th class="num">⭐ Driver</th><th class="num">cycle</th><th>Time</th>
</tr>`;

// A small badge for the world a run played: the gauntlet, or a single city's name.
function worldBadge(r) {
  const name = r.city_name || (r.city_id === "gauntlet" ? "Gauntlet" : "Metropolis");
  const isG = r.city_id === "gauntlet";
  const legCount = Array.isArray(r.legs) ? r.legs.length : 0;
  const title = isG && legCount ? `Gauntlet of ${legCount} cities` : esc(name);
  return `<span class="world-badge${isG ? " gauntlet" : ""}" title="${title}">${isG ? "🏟 " : "🌍 "}${esc(name)}</span>`;
}

function makerLink(r) {
  const name = esc(r.creator || "—");
  return r.user_id
    ? `<a class="maker-link" href="/results.html?user=${encodeURIComponent(r.user_id)}">${name}</a>`
    : name;
}

function replayLink(r, label) {
  return r.id ? `<a class="maker-link" href="/replay.html?id=${encodeURIComponent(r.id)}" title="Watch replay">${label}</a>` : "";
}

function leaderboardRow(r, i) {
  return `<tr>
    <td class="num rank">${i + 1}</td>
    <td><span class="maker">${makerLink(r)}</span> ${replayLink(r, "▶")}</td>
    <td>${worldBadge(r)}</td>
    <td class="num">${fmt(r.revenue)}</td>
    <td class="num good">${r.completed}</td>
    <td class="num bad">${r.cancelled}</td>
    <td class="num">${Number(r.rider_avg).toFixed(2)}</td>
    <td class="num">${Number(r.driver_avg).toFixed(2)}</td>
    <td class="num runs">${r.runs ?? 1}</td>
  </tr>`;
}

function runRow(r, i) {
  return `<tr>
    <td class="num rank">${i + 1}</td>
    <td><span class="maker">${makerLink(r)}</span></td>
    <td class="sid">${replayLink(r, "▶ " + esc(r.id))}</td>
    <td>${worldBadge(r)}</td>
    <td class="num">${fmt(r.revenue)}</td>
    <td class="num good">${r.completed}</td>
    <td class="num bad">${r.cancelled}</td>
    <td class="num">${Number(r.rider_avg).toFixed(2)}</td>
    <td class="num">${Number(r.driver_avg).toFixed(2)}</td>
    <td class="num">${r.ticks}</td>
    <td class="when">${when(r.finished_at)}</td>
  </tr>`;
}

function setActive() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === (view === "user" ? "" : view)));
}

async function load() {
  const head = document.getElementById("head");
  const tbody = document.getElementById("rows");
  const subtitle = document.getElementById("subtitle");
  setActive();

  // Show the "My runs" tab only when logged in.
  const meTab = document.getElementById("tab-me");
  if (meTab) meTab.style.display = window.US_AUTH && US_AUTH.token ? "" : "none";

  try {
    if (view === "leaderboard") {
      head.innerHTML = HEAD_LEADERBOARD;
      subtitle.textContent = "Best run per player, ranked by revenue.";
      const rows = (await api("/leaderboard?limit=100")).leaderboard || [];
      tbody.innerHTML = rows.length
        ? rows.map(leaderboardRow).join("")
        : '<tr><td colspan="9" class="empty">No finished sessions yet.</td></tr>';
      return;
    }

    head.innerHTML = HEAD_RUNS;
    let path = "/results?limit=200";
    if (view === "me") {
      if (!(window.US_AUTH && US_AUTH.id)) {
        subtitle.textContent = "";
        tbody.innerHTML = '<tr><td colspan="11" class="empty">Log in (top right) to see your runs.</td></tr>';
        return;
      }
      path = `/results?user=${encodeURIComponent(US_AUTH.id)}&limit=200`;
      subtitle.textContent = `Your runs, ${US_AUTH.user}.`;
    } else if (view === "user") {
      path = `/results?user=${encodeURIComponent(userParam)}&limit=200`;
      subtitle.textContent = "All runs by this player.";
    } else {
      subtitle.textContent = "Every finished session — public, newest first.";
    }
    const rows = (await api(path)).results || [];
    tbody.innerHTML = rows.length
      ? rows.map(runRow).join("")
      : '<tr><td colspan="11" class="empty">No finished sessions yet.</td></tr>';
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">Error fetching results (is the engine up?).</td></tr>';
  }
}

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  view = btn.dataset.view;
  // Reflect the active view in the URL without reloading.
  history.replaceState(null, "", view === "leaderboard" ? "/results.html" : `/results.html?${view}=1`);
  load();
});

if (window.US_AUTH) US_AUTH.onChange(load);
load();
setInterval(load, 3000); // auto-refresh when a new session finishes
