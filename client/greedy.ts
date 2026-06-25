/**
 * Sample matcher (reference for participants) — WebSocket version.
 *
 * Instead of polling, it opens a socket: the server pushes the world state each
 * cycle, and the client immediately returns the assignments over the same
 * socket. (No back-to-back requests.)
 *
 *   - If SESSION_ID is provided, it connects to that same world.
 *   - Otherwise it creates a new world via REST, then opens the socket.
 *
 * Run:  npm run client
 *       BASE_URL=http://host:8080 SESSION_ID=brave-fox-1 npm run client
 *
 * Each participant only changes the `decide()` function.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const WS_BASE = BASE.replace(/^http/, "ws");

interface Vec2 { x: number; y: number; }
interface State {
  status: string;
  tick: number;
  idleDrivers: { id: string; pos: Vec2 }[];
  openRequests: { id: string; origin: Vec2; destination: Vec2; waitedMinutes: number }[];
}
interface Assignment { driverId: string; tripId: string; }

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** ----- Core participant logic ----- */
function decide(state: State): Assignment[] {
  const assignments: Assignment[] = [];
  const free = new Set(state.idleDrivers.map((d) => d.id));
  const byId = new Map(state.idleDrivers.map((d) => [d.id, d]));

  const requests = [...state.openRequests].sort((a, b) => b.waitedMinutes - a.waitedMinutes);
  for (const req of requests) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const id of free) {
      const d = dist(byId.get(id)!.pos, req.origin);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best) {
      assignments.push({ driverId: best, tripId: req.id });
      free.delete(best);
    }
  }
  return assignments;
}
/** -------------------------------- */

async function main() {
  let session = process.env.SESSION_ID ?? "";
  if (!session) {
    const name = (process.env.MATCHER_NAME ?? "Greedy").trim();
    if (!name) {
      console.error('❌ MATCHER_NAME is required. Example:  MATCHER_NAME="Team Alpha" npm run client');
      process.exit(1);
    }
    const r = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((x) => x.json());
    session = r.id;
    console.log(`🌍 New world created: ${session} (creator: ${name})`);
  }

  const ws = new WebSocket(`${WS_BASE}/sessions/${session}/ws`);

  ws.addEventListener("open", () => console.log(`🔌 Socket connected to ${session} — waiting for state…`));
  ws.addEventListener("error", (e: any) => console.error("Socket error:", e?.message ?? e));
  ws.addEventListener("close", () => console.log("Socket closed."));

  ws.addEventListener("message", (ev: any) => {
    const state: State = JSON.parse(ev.data as string);
    if (state.status === "finished") {
      console.log(`🏁 session ${session} finished.`);
      ws.close();
      process.exit(0);
    }
    if (state.status !== "running") return;
    const assignments = decide(state);
    ws.send(JSON.stringify({ tick: state.tick, assignments }));
    console.log(
      `[${session}] tick ${state.tick}: ${state.openRequests.length} requests, ${state.idleDrivers.length} idle → ${assignments.length} assigned`,
    );
  });
}

main();
