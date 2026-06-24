/* صفحهٔ نتایج: جدولِ سشن‌های تمام‌شده از GET /results (مرتب بر اساس درآمد). */

const fmt = (n) => Math.round(Number(n)).toLocaleString("en-US");
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function when(ts) {
  try { return new Date(ts).toLocaleString("fa-IR"); } catch { return ts; }
}

function rowHtml(r, i) {
  const type = r.auto_match
    ? '<span class="pill auto">auto (greedy)</span>'
    : '<span class="pill ext">matcher بیرونی</span>';
  return `<tr>
    <td class="num rank">${i + 1}</td>
    <td><span class="maker">${esc(r.creator || "—")}</span> <span class="sid">${esc(r.id)}</span></td>
    <td>${type}</td>
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
      tbody.innerHTML = '<tr><td colspan="10" class="empty">هنوز سشنِ تمام‌شده‌ای ذخیره نشده.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(rowHtml).join("");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">خطا در گرفتنِ نتایج (engine بالا نیست؟).</td></tr>';
  }
}

load();
setInterval(load, 3000); // به‌روزرسانیِ خودکار وقتی سشنِ تازه‌ای تمام می‌شود
