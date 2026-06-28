/*
 * Shared auth widget — login / register + token display.
 *
 * Drop a `<div id="authbar"></div>` on a page and include this script; it
 * renders the right state and keeps the token in localStorage. Other scripts
 * read window.US_AUTH for the current user/token and an Authorization header.
 */

const US_TOKEN_KEY = "ubersim_token";
const US_USER_KEY = "ubersim_user";

const US_AUTH = {
  get token() { return localStorage.getItem(US_TOKEN_KEY) || ""; },
  get user() { return localStorage.getItem(US_USER_KEY) || ""; },
  get id() { return localStorage.getItem("ubersim_id") || ""; },
  /** Authorization header for API calls (empty object when logged out). */
  header() { const t = this.token; return t ? { Authorization: "Bearer " + t } : {}; },
  set(id, username, token) {
    localStorage.setItem("ubersim_id", id);
    localStorage.setItem(US_USER_KEY, username);
    localStorage.setItem(US_TOKEN_KEY, token);
    this._emit();
  },
  clear() {
    localStorage.removeItem("ubersim_id");
    localStorage.removeItem(US_USER_KEY);
    localStorage.removeItem(US_TOKEN_KEY);
    this._emit();
  },
  _listeners: [],
  onChange(fn) { this._listeners.push(fn); },
  _emit() { for (const fn of this._listeners) try { fn(); } catch {} },
};
window.US_AUTH = US_AUTH;

(function injectStyles() {
  const css = `
  #authbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  #authbar input { font-family:inherit; background:#11161c; color:var(--text,#e6edf3);
    border:1px solid var(--line,#2a3340); border-radius:7px; padding:8px 10px; font-size:13px; width:140px; }
  #authbar .auth-me { display:flex; align-items:center; gap:10px; font-size:13px; }
  #authbar .auth-me b { color:var(--accent,#d29922); }
  #authbar code { font-family:"SF Mono",Menlo,Consolas,monospace; direction:ltr; background:#11161c;
    border:1px solid var(--line,#2a3340); border-radius:5px; padding:2px 7px; font-size:12px; }
  #authbar .auth-msg { font-size:12px; color:var(--muted,#8b98a5); }
  #authbar .auth-msg.err { color:#f85149; }
  #authbar .auth-msg.ok { color:#3fb950; }
  #authbar a.navlink { font-family:inherit; background:transparent; color:var(--text,#e6edf3);
    border:1px solid var(--line,#2a3340); border-radius:7px; padding:8px 12px; font-weight:700;
    font-size:13px; text-decoration:none; }
  `;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
})();

async function authPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "request failed");
  return data;
}

function render() {
  const bar = document.getElementById("authbar");
  if (!bar) return;
  if (US_AUTH.token) {
    bar.innerHTML = `
      <div class="auth-me">
        <span>👤 <b>${escapeHtml(US_AUTH.user)}</b></span>
        <span>🔑 <code title="Your matcher API token">${escapeHtml(US_AUTH.token)}</code></span>
        <button class="ghost" data-act="copy">Copy token</button>
        <a class="navlink" href="/results.html?me=1">🏆 My scoreboard</a>
        <button class="ghost" data-act="logout">Logout</button>
        <span class="auth-msg"></span>
      </div>`;
  } else {
    bar.innerHTML = `
      <input name="username" placeholder="username" autocomplete="username" />
      <input name="password" type="password" placeholder="password" autocomplete="current-password" />
      <button data-act="login">Login</button>
      <button class="ghost" data-act="register">Register</button>
      <span class="auth-msg"></span>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function msg(text, kind) {
  const m = document.querySelector("#authbar .auth-msg");
  if (m) { m.textContent = text; m.className = "auth-msg" + (kind ? " " + kind : ""); }
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("#authbar [data-act]");
  if (!btn) return;
  e.preventDefault();
  const act = btn.dataset.act;
  const bar = document.getElementById("authbar");

  if (act === "logout") { US_AUTH.clear(); return; }
  if (act === "copy") {
    try { await navigator.clipboard.writeText(US_AUTH.token); msg("token copied ✓", "ok"); }
    catch { msg("copy failed — select it manually", "err"); }
    return;
  }
  if (act === "login" || act === "register") {
    const username = bar.querySelector('input[name="username"]').value.trim();
    const password = bar.querySelector('input[name="password"]').value;
    if (!username || !password) { msg("enter username and password", "err"); return; }
    msg(act === "login" ? "logging in…" : "registering…");
    try {
      const r = await authPost("/auth/" + act, { username, password });
      US_AUTH.set(r.id, r.username, r.token);
    } catch (err) { msg(err.message, "err"); }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.closest("#authbar input")) {
    const loginBtn = document.querySelector('#authbar [data-act="login"]');
    if (loginBtn) loginBtn.click();
  }
});

US_AUTH.onChange(render);
render();
