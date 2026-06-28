import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { createStore } from "./store.js";
import { AuthService, AuthError } from "./auth.js";
import type { Engine } from "./engine.js";
import type { User } from "./store.js";
import type { Assignment } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const store = createStore();
store.init().catch((e) => console.error("database init failed:", e));
const auth = new AuthService(store);
const manager = new SessionManager(store);
// When any session is removed/cleaned up (manually or automatically after it ends), close its WebSockets.
manager.onEvict = (id) => closeSessionSockets(id);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

type Res = import("node:http").ServerResponse;
type Req = import("node:http").IncomingMessage;

function send(res: Res, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: Req): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

/**
 * Pull the API token out of a request: `Authorization: Bearer <token>` header,
 * or a `?token=` query param (handy for WebSocket connections from a browser).
 */
function tokenFromReq(req: Req, url: URL): string | undefined {
  const header = req.headers["authorization"];
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return url.searchParams.get("token") ?? undefined;
}

async function serveStatic(res: Res, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not Found");
  }
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const seg = url.pathname.split("/").filter(Boolean); // ["sessions","s1","state"]

  if (method === "OPTIONS") return send(res, 204, {});

  try {
    // ---- /config → the engine's tunable simulation parameters (for the landing page) ----
    if (seg[0] === "config" && seg.length === 1 && method === "GET") {
      return send(res, 200, { config });
    }

    // ---- /auth → register / login / who-am-I ----
    if (seg[0] === "auth") {
      if (seg[1] === "register" && method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        try {
          const r = await auth.register(String(body.username ?? ""), String(body.password ?? ""));
          return send(res, 201, r);
        } catch (e) {
          if (e instanceof AuthError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (seg[1] === "login" && method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        try {
          const r = await auth.login(String(body.username ?? ""), String(body.password ?? ""));
          return send(res, 200, r);
        } catch (e) {
          if (e instanceof AuthError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (seg[1] === "me" && method === "GET") {
        const user = await auth.userFromToken(tokenFromReq(req, url));
        if (!user) return send(res, 401, { error: "not logged in" });
        return send(res, 200, { id: user.id, username: user.username, token: user.token });
      }
      return send(res, 404, { error: "invalid auth route" });
    }

    // ---- /results → every finished session, public so anyone can see all submissions ----
    if (seg[0] === "results" && seg.length === 1 && method === "GET") {
      const limit = Number(url.searchParams.get("limit")) || 100;
      const userId = url.searchParams.get("user");
      const results = userId
        ? await store.listResultsByUser(userId, limit)
        : await store.listResults(limit);
      return send(res, 200, { results });
    }

    // ---- /leaderboard → one row per user (their best run) ----
    if (seg[0] === "leaderboard" && seg.length === 1 && method === "GET") {
      const limit = Number(url.searchParams.get("limit")) || 100;
      return send(res, 200, { leaderboard: await store.leaderboard(limit) });
    }

    // ---- /replays/:id → a finished run's frame-by-frame recording (public) ----
    if (seg[0] === "replays" && seg.length === 2 && method === "GET") {
      const replay = await store.getReplay(seg[1]);
      if (!replay) return send(res, 404, { error: "no replay for this session" });
      return send(res, 200, { id: seg[1], replay });
    }

    // ---- /sessions ----
    if (seg[0] === "sessions") {
      // GET /sessions → list all worlds (full vizState for each)
      if (seg.length === 1 && method === "GET") {
        return send(res, 200, { sessions: manager.listViz() });
      }
      // POST /sessions → create a session. Requires a valid API token so the
      //   world is provably owned by a logged-in user. An empty, idle session is
      //   created; it starts on the first matcher connection (GET /state or ws).
      if (seg.length === 1 && method === "POST") {
        const user = await auth.userFromToken(tokenFromReq(req, url));
        if (!user) return send(res, 401, { error: "a valid API token is required to create a session" });
        const { id, engine } = manager.create(user);
        return send(res, 201, { id, creator: engine.creator, status: engine.status });
      }

      const id = seg[1];
      const engine = id ? manager.get(id) : undefined;
      const action = seg[2];

      // Resolve the request's user once; only the owner may drive/reset/delete a session.
      const reqUser = await auth.userFromToken(tokenFromReq(req, url));
      const ownsEngine = (e: Engine): boolean => !!reqUser && reqUser.id === e.userId;

      // DELETE /sessions/:id  (remove() closes the WebSockets itself)
      if (seg.length === 2 && method === "DELETE") {
        if (!engine) return send(res, 404, { error: `session ${id} not found` });
        if (!ownsEngine(engine)) return send(res, 403, { error: "only the owner can delete this session" });
        return send(res, manager.remove(id) ? 200 : 404, { removed: id });
      }
      if (!engine) return send(res, 404, { error: `session ${id} not found` });

      // ---- public, read-only views (anyone can watch any world) ----
      if (action === "viz" && method === "GET") {
        return send(res, 200, { id, ...engine.vizState() });
      }

      // ---- driving the matcher → owner only ----
      if (action === "state" && method === "GET") {
        if (!ownsEngine(engine)) return send(res, 403, { error: "only the owner can drive this session" });
        // First read of state = matcher connection → start the waiting session
        if (engine.status === "idle") engine.start();
        return send(res, 200, { id, status: engine.status, ...engine.snapshot });
      }
      if (action === "assign" && method === "POST") {
        if (!ownsEngine(engine)) return send(res, 403, { error: "only the owner can drive this session" });
        const body = await readJsonBody(req);
        const tick = Number(body.tick);
        const assignments: Assignment[] = Array.isArray(body.assignments) ? body.assignments : [];
        const result = engine.submitAssignments(tick, assignments);
        return send(res, result.ok ? 200 : 409, result);
      }
      if (action === "start" && method === "POST") {
        if (!ownsEngine(engine)) return send(res, 403, { error: "only the owner can start this session" });
        engine.start();
        return send(res, 200, { id, status: engine.status });
      }
      if (action === "reset" && method === "POST") {
        if (!ownsEngine(engine)) return send(res, 403, { error: "only the owner can reset this session" });
        engine.reset();
        return send(res, 200, { id, status: engine.status });
      }
      return send(res, 404, { error: "invalid route" });
    }

    // ---- static files (UI) ----
    if (method === "GET") return serveStatic(res, url.pathname);
    return send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: String(err) });
  }
});

// ---- WebSocket for the matcher (instead of polling) ----
// path: ws://host/sessions/:id/ws
// The server pushes a snapshot every cycle; the client replies with a { tick, assignments } message.
const wss = new WebSocketServer({ noServer: true });
const wsClients = new Map<string, Set<WebSocket>>(); // sessionId → sockets

function broadcast(id: string, payload: unknown): void {
  const set = wsClients.get(id);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(msg);
}

/** Close a session's sockets (on removal). */
export function closeSessionSockets(id: string): void {
  const set = wsClients.get(id);
  if (!set) return;
  for (const ws of set) ws.close();
  wsClients.delete(id);
}

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "sessions" || seg[2] !== "ws") return socket.destroy();
  const engine = manager.get(seg[1]);
  if (!engine) return socket.destroy();
  // Only the owning user may drive the session — the matcher must present the
  // owner's API token (Authorization header or ?token=).
  const user = await auth.userFromToken(tokenFromReq(req, url));
  if (!user || user.id !== engine.userId) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleMatcherSocket(ws, seg[1], engine);
  });
});

function handleMatcherSocket(ws: WebSocket, id: string, engine: Engine): void {
  let set = wsClients.get(id);
  if (!set) { set = new Set(); wsClients.set(id, set); }
  set.add(ws);

  // matcher connection = start the waiting session
  if (engine.status === "idle") engine.start();
  // Every cycle, push the snapshot to all of this session's sockets
  engine.onSnapshot = (snapshot, status) => broadcast(id, { id, status, ...snapshot });
  // Send the current snapshot immediately so the matcher can start right away
  ws.send(JSON.stringify({ id, status: engine.status, ...engine.snapshot }));

  ws.on("message", (data) => {
    try {
      const body = JSON.parse(data.toString());
      const assignments: Assignment[] = Array.isArray(body.assignments) ? body.assignments : [];
      engine.submitAssignments(Number(body.tick), assignments);
    } catch { /* invalid message */ }
  });
  ws.on("close", () => {
    set!.delete(ws);
    // When the last matcher disconnects, treat the session as over: stop the
    // engine and drop it from memory. remove() also closes any sockets and
    // clears the wsClients entry, so it's safe (and idempotent) here.
    if (set!.size === 0) manager.remove(id);
  });
}

server.listen(config.port, () => {
  console.log(`🚕 Uber-sim (multi-session) on http://localhost:${config.port}`);
  console.log(`   UI:       http://localhost:${config.port}/`);
  console.log(`   Sessions: POST /sessions , GET /sessions`);
  console.log(`   Matcher:  GET /sessions/:id/state , POST /sessions/:id/assign`);
  console.log(`   cycle every ${config.cycleMs}ms , session ${config.sessionTicks} cycles`);
});
