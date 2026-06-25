import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { createStore } from "./store.js";
import type { Engine } from "./engine.js";
import type { Assignment } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const store = createStore();
store.init().catch((e) => console.error("database init failed:", e));
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
    // ---- /results → archived results of finished sessions (leaderboard) ----
    if (seg[0] === "results" && seg.length === 1 && method === "GET") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      return send(res, 200, { results: await store.listResults(limit) });
    }

    // ---- /sessions ----
    if (seg[0] === "sessions") {
      // GET /sessions → list all worlds (full vizState for each)
      if (seg.length === 1 && method === "GET") {
        return send(res, 200, { sessions: manager.listViz() });
      }
      // POST /sessions → create a session (by code, via an external matcher). body: { name }
      //   An empty, idle session is created; it starts on the first matcher connection (GET /state or ws).
      if (seg.length === 1 && method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return send(res, 400, { error: "creator name (name) is required" });
        const { id, engine } = manager.create(name.slice(0, 60));
        return send(res, 201, { id, creator: engine.creator, status: engine.status });
      }

      const id = seg[1];
      const engine = id ? manager.get(id) : undefined;

      // DELETE /sessions/:id  (remove() closes the WebSockets itself)
      if (seg.length === 2 && method === "DELETE") {
        return send(res, manager.remove(id) ? 200 : 404, { removed: id });
      }
      if (!engine) return send(res, 404, { error: `session ${id} not found` });

      const action = seg[2];
      if (action === "state" && method === "GET") {
        // First read of state = matcher connection → start the waiting session
        if (engine.status === "idle") engine.start();
        return send(res, 200, { id, status: engine.status, ...engine.snapshot });
      }
      if (action === "viz" && method === "GET") {
        return send(res, 200, { id, ...engine.vizState() });
      }
      if (action === "assign" && method === "POST") {
        const body = await readJsonBody(req);
        const tick = Number(body.tick);
        const assignments: Assignment[] = Array.isArray(body.assignments) ? body.assignments : [];
        const result = engine.submitAssignments(tick, assignments);
        return send(res, result.ok ? 200 : 409, result);
      }
      if (action === "start" && method === "POST") {
        engine.start();
        return send(res, 200, { id, status: engine.status });
      }
      if (action === "reset" && method === "POST") {
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

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "sessions" || seg[2] !== "ws") return socket.destroy();
  const engine = manager.get(seg[1]);
  if (!engine) return socket.destroy();
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
    if (set!.size === 0) { wsClients.delete(id); engine.onSnapshot = undefined; }
  });
}

server.listen(config.port, () => {
  console.log(`🚕 Uber-sim (multi-session) on http://localhost:${config.port}`);
  console.log(`   UI:       http://localhost:${config.port}/`);
  console.log(`   Sessions: POST /sessions , GET /sessions`);
  console.log(`   Matcher:  GET /sessions/:id/state , POST /sessions/:id/assign`);
  console.log(`   cycle every ${config.cycleMs}ms , session ${config.sessionTicks} cycles`);
});
