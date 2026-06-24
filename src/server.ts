import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { config } from "./config.js";
import { Engine } from "./engine.js";
import type { Assignment } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const engine = new Engine();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(json);
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function serveStatic(res: import("node:http").ServerResponse, urlPath: string): Promise<void> {
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
  const url = new URL(req.url ?? "/", `http://localhost`);
  const path = url.pathname;

  if (method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  try {
    // ---- API ----
    if (path === "/state" && method === "GET") {
      // snapshot برای Matcher (رانندگان IDLE + درخواست‌های باز)
      send(res, 200, { status: engine.status, ...engine.snapshot });
      return;
    }

    if (path === "/assign" && method === "POST") {
      const body = await readJsonBody(req);
      const tick = Number(body.tick);
      const assignments: Assignment[] = Array.isArray(body.assignments) ? body.assignments : [];
      const result = engine.submitAssignments(tick, assignments);
      send(res, result.ok ? 200 : 409, result);
      return;
    }

    if (path === "/viz" && method === "GET") {
      send(res, 200, engine.vizState());
      return;
    }

    if (path === "/session/start" && method === "POST") {
      engine.start();
      send(res, 200, { status: engine.status });
      return;
    }

    if (path === "/session/reset" && method === "POST") {
      engine.reset();
      send(res, 200, { status: engine.status });
      return;
    }

    // ---- فایل‌های استاتیک (UI) ----
    if (method === "GET") {
      await serveStatic(res, path);
      return;
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: String(err) });
  }
});

server.listen(config.port, () => {
  console.log(`🚕 Uber-sim engine روی http://localhost:${config.port}`);
  console.log(`   UI:        http://localhost:${config.port}/`);
  console.log(`   Matcher:   GET /state ، POST /assign`);
  console.log(`   cycle هر ${config.cycleMs}ms ، session ${config.sessionTicks} cycle`);
});
