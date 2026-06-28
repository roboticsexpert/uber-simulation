/**
 * Sample matcher (reference for participants) — WebSocket version.
 *
 * Instead of polling, it opens a socket: the server pushes the world state
 * every cycle, and the client immediately returns its assignments on the
 * same socket. (No back-to-back requests.)
 *
 *   - If SESSION_ID is given, it connects to that same world.
 *   - Otherwise it creates a new world over REST, then opens the socket.
 *
 * Auth: every session belongs to a logged-in user. Register on the website to
 * get your API token, then pass it as TOKEN — the client uses it to prove who
 * it is (so your runs land on your personal scoreboard).
 *
 * Run:  TOKEN=your_api_token npm start
 *       BASE_URL=http://host:8080 TOKEN=... SESSION_ID=brave-fox-1 npm start
 *
 * Each participant only changes the `decide()` function.
 */

const BASE = process.env.BASE_URL ?? "https://snapp.zisef.ir";
const WS_BASE = BASE.replace(/^http/, "ws");
const TOKEN = (process.env.TOKEN ?? "").trim();

interface Vec2 { x: number; y: number; }
interface State {
  status: string;
  tick: number;
  idleDrivers: { id: string; pos: Vec2 }[];
  openRequests: { id: string; origin: Vec2; destination: Vec2; waitedMinutes: number }[];
}
interface Assignment { driverId: string; tripId: string; }

/** ----- Participant logic ----- */
// Simple strategy: give each open request the first available free driver.
function decide(state: State): Assignment[] {
  const assignments: Assignment[] = [];
  const freeDrivers = [...state.idleDrivers];

  for (const req of state.openRequests) {
    const driver = freeDrivers.shift();
    if (!driver) break; // no free drivers left
    assignments.push({ driverId: driver.id, tripId: req.id });
  }
  return assignments;
}
/** ------------------------------ */

async function main() {
  if (!TOKEN) {
    console.error("❌ TOKEN is required. Register on the website to get your API token, then:  TOKEN=your_api_token npm start");
    process.exit(1);
  }

  let session = process.env.SESSION_ID ?? "";
  if (!session) {
    const r = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: "{}",
    }).then((x) => x.json());
    if (!r.id) {
      console.error(`❌ Could not create a session: ${r.error ?? "unknown error"} (is your TOKEN valid?)`);
      process.exit(1);
    }
    session = r.id;
    console.log(`🌍 New world created: ${session} (creator: ${r.creator})`);
  }

  console.log(`👀 Watch your world live:  ${BASE}/world.html?id=${session}`);

  // The token goes on the socket URL so the server knows the matcher is yours.
  const ws = new WebSocket(`${WS_BASE}/sessions/${session}/ws?token=${encodeURIComponent(TOKEN)}`);

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
      `[${session}] tick ${state.tick}: ${state.openRequests.length} requests, ${state.idleDrivers.length} free → ${assignments.length} assigned`,
    );
  });
}

main();
