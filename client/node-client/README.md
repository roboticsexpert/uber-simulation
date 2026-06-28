# Sample Matcher — Node.js (simple version)

A simple client for the matching competition. Every cycle, the server pushes the
world state over a WebSocket; this client returns its assignments (driver ↔ trip).

You only change the **`decide()`** function inside `sample-client.ts` — the rest
of the code (connection, session creation, socket loop) is ready to go.

## Requirements

- Node.js **22 or higher** (needs global `WebSocket` and `fetch` — no extra
  libraries required; only `tsx` to run the TypeScript).

## Install

```bash
npm install
```

## Run

Register on the website to get your **API token**, then create a new world:

```bash
TOKEN=your_api_token npm start
```

Connect to an existing session:

```bash
BASE_URL=http://localhost:8080 TOKEN=your_api_token SESSION_ID=brave-fox-1 npm start
```

## Environment variables

| Variable     | Default                 | Description                                              |
| ------------ | ----------------------- | -------------------------------------------------------- |
| `BASE_URL`   | `http://localhost:8080` | Server address (`https` automatically becomes `wss`).    |
| `TOKEN`      | —                       | **Required.** Your API token (from the website) — identifies your account. |
| `SESSION_ID` | —                       | If given, connects to that session instead of creating one. |

## Watch your world live

On start, the client prints a link to your live world — click it to watch your
drivers, riders, and scoreboard in real time:

```
👀 Watch your world live:  https://snapp.zisef.ir/world.html?id=brave-fox-1
```

## Algorithm

The sample `decide()` uses the simplest possible strategy: it walks the open
requests in order and gives each one the **first available free driver**. Replace
it with your own matching logic.

## Protocol (for reference)

- **Create session:** `POST /sessions` with body `{ "name": "..." }` → response `{ "id": "..." }`
- **Socket:** `ws://HOST/sessions/<id>/ws`
  - The server sends every cycle:
    ```json
    {
      "status": "running",
      "tick": 12,
      "idleDrivers":  [{ "id": "d1", "pos": { "x": 0, "y": 0 } }],
      "openRequests": [{ "id": "t1", "origin": { "x": 1, "y": 2 },
                         "destination": { "x": 3, "y": 4 }, "waitedMinutes": 5 }]
    }
    ```
  - The client replies:
    ```json
    { "tick": 12, "assignments": [{ "driverId": "d1", "tripId": "t1" }] }
    ```
  - When `status` becomes `"finished"`, the session is over.
