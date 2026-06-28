"""
Sample matcher (Python version) — equivalent of sample-client.ts over WebSocket.

The server pushes the world state every cycle; the client immediately returns
its assignments on the same socket. (No polling.)

  - If SESSION_ID is given, it connects to that same world.
  - Otherwise it creates a new world over REST, then opens the socket.

Auth: every session belongs to a logged-in user. Register on the website to get
your API token, then pass it as TOKEN — the client uses it to prove who it is
(so your runs land on your personal scoreboard).

Install dependencies:
    pip install -r requirements.txt

Run:
    TOKEN=your_api_token python sample_client.py
    BASE_URL=http://host:8080 TOKEN=... SESSION_ID=brave-fox-1 python sample_client.py

Each participant only changes the `decide()` function.
"""

import asyncio
import json
import os
import sys
import urllib.request

import websockets

BASE = os.environ.get("BASE_URL", "https://snapp.zisef.ir")
WS_BASE = "ws" + BASE[len("http"):]  # http→ws, https→wss
TOKEN = os.environ.get("TOKEN", "").strip()


# ----- Participant logic -----
def decide(state: dict) -> list[dict]:
    """Simple strategy: give each open request the first available free driver."""
    assignments: list[dict] = []
    free_drivers = list(state["idleDrivers"])
    i = 0

    for req in state["openRequests"]:
        if i >= len(free_drivers):
            break  # no free drivers left
        assignments.append({"driverId": free_drivers[i]["id"], "tripId": req["id"]})
        i += 1
    return assignments
# -----------------------------


def create_session() -> dict:
    """Creates a new world over REST (authenticated by TOKEN) and returns the response."""
    req = urllib.request.Request(
        f"{BASE}/sessions",
        data=b"{}",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


async def main() -> None:
    if not TOKEN:
        print("❌ TOKEN is required. Register on the website to get your API token, then:  TOKEN=your_api_token python sample_client.py")
        sys.exit(1)

    session = os.environ.get("SESSION_ID", "")
    if not session:
        r = create_session()
        session = r["id"]
        print(f"🌍 New world created: {session} (creator: {r.get('creator')})")

    print(f"👀 Watch your world live:  {BASE}/world.html?id={session}")

    # The token goes on the socket URL so the server knows the matcher is yours.
    url = f"{WS_BASE}/sessions/{session}/ws?token={TOKEN}"
    async with websockets.connect(url) as ws:
        print(f"🔌 Socket connected to {session} — waiting for state…")
        async for raw in ws:
            state = json.loads(raw)

            if state.get("status") == "finished":
                print(f"🏁 session {session} finished.")
                break
            if state.get("status") != "running":
                continue

            assignments = decide(state)
            await ws.send(json.dumps({"tick": state["tick"], "assignments": assignments}))
            print(
                f"[{session}] tick {state['tick']}: "
                f"{len(state['openRequests'])} requests, "
                f"{len(state['idleDrivers'])} free → {len(assignments)} assigned"
            )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
