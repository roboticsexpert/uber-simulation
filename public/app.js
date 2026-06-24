/* صفحهٔ گرید: همهٔ دنیاها به‌صورت mini-map؛ کلیک روی هر کارت → صفحهٔ جدا. */

let worlds = []; // [{id, ...vizState}]
const cardCanvas = {}; // sid → canvas

document.getElementById("new-auto").onclick = () => api("/sessions", "POST", { auto: true }).then(poll);
document.getElementById("new-empty").onclick = () => api("/sessions", "POST", { auto: false }).then(poll);

function frame() {
  for (const w of worlds) {
    const cv = cardCanvas[w.id];
    if (cv && cv.isConnected) drawWorld(cv.getContext("2d"), cv.clientWidth, cv.clientHeight, w, 0.6);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function syncCards() {
  const grid = document.getElementById("grid");
  const empty = grid.querySelector(".empty");
  if (empty && worlds.length) empty.remove();

  const ids = new Set(worlds.map((w) => w.id));
  for (const id of Object.keys(cardCanvas)) {
    if (!ids.has(id)) {
      const el = document.getElementById("card-" + id);
      if (el) el.remove();
      delete cardCanvas[id];
    }
  }
  for (const w of worlds) {
    let el = document.getElementById("card-" + w.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "card"; el.id = "card-" + w.id;
      el.innerHTML = `<canvas></canvas><div class="card-foot">
        <span class="cid">${w.id}</span>
        <span class="cstat"></span><span style="flex:1"></span>
        <span class="pill idle"></span></div>`;
      // کلیک → صفحهٔ جدا
      el.onclick = () => { window.location.href = "/world.html?id=" + encodeURIComponent(w.id); };
      grid.appendChild(el);
      cardCanvas[w.id] = el.querySelector("canvas");
    }
    const sb = w.scoreboard;
    el.querySelector(".cstat").textContent = `✅${sb.completed} ❌${sb.cancelled} ⭐${sb.riderAvg.toFixed(1)}`;
    const pill = el.querySelector(".pill");
    const waiting = w.status === "idle";
    pill.textContent = waiting ? "منتظر matcher" : w.status;
    pill.className = "pill " + (waiting ? "waiting" : w.status);
  }
  if (worlds.length === 0 && !grid.querySelector(".empty")) {
    grid.innerHTML = `<div class="empty">هنوز دنیایی نیست. «دنیای جدید» را بزن یا با <code>npm run client</code> یک matcher وصل کن.</div>`;
  }
}

async function poll() {
  try {
    const r = await api("/sessions");
    worlds = r.sessions || [];
    for (const w of worlds) setupAnim(w);
    syncCards();
  } catch (e) { /* engine بالا نیست */ }
}

setInterval(poll, 200);
poll();
