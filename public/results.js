/* Results page: table of finished sessions from GET /results (sorted by revenue). */

const fmt = (n) => Math.round(Number(n)).toLocaleString("en-US");
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function when(ts) {
  try { return new Date(ts).toLocaleString("en-US"); } catch { return ts; }
}

function rowHtml(r, i) {
  return `<tr>
    <td class="num rank">${i + 1}</td>
    <td><span class="maker">${esc(r.creator || "—")}</span> <span class="sid">${esc(r.id)}</span></td>
    <td class="num">${fmt(r.revenue)}</td>
    <td class="num good">${r.completed}</td>
    <td class="num bad">${r.cancelled}</td>
    <td class="num">${Number(r.rider_avg).toFixed(2)}</td>
    <td class="num">${Number(r.driver_avg).toFixed(2)}</td>
    <td class="num">${r.ticks}</td>
    <td class="when">${when(r.finished_at)}</td>
  </tr>`;
}

async function load() {
  const tbody = document.getElementById("rows");
  try {
    const r = await api("/results?limit=100");
    const rows = r.results || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty">No finished sessions saved yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(rowHtml).join("");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Error fetching results (is the engine up?).</td></tr>';
  }
}

load();
setInterval(load, 3000); // auto-refresh when a new session finishes
