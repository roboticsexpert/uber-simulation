# Matching Arena Platform — Architecture and API

> Technical platform document. Game rules in [GAME_DESIGN.md](./GAME_DESIGN.md).
> Version: 0.2 — multi-session

## 1. Architecture

```
┌───────────────────────────────────────────────────┐
│                 SessionManager                     │
│   Map<sessionId, Engine>  (up to 16 sessions)      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ Engine A │  │ Engine B │  │ Engine C │  ...     │
│  │ World+loop│ │ World+loop│ │ World+loop│         │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
└───────┼─────────────┼─────────────┼────────────────┘
  /sessions/A/...  /sessions/B/...  /sessions/C/...
   Matcher A         Matcher B        Matcher C
        └──────── GET /sessions ───────► UI grid (all worlds)
```

- Several independent **Engine**s run concurrently; each has its own `World` and time loop.
- All sessions use the **same config** (same `SEED` and parameters) ⇒ identical initial world and demand. The only difference in outcome comes from the quality of the **Matcher** — perfect fairness.
- Sessions are **in-memory** and transient; they are wiped when the process restarts.

Three components:
- **Engine** (`src/`): the simulation core. `SessionManager` holds multiple instances.
- **UI** (`public/`): a live grid of all worlds; click a card → full view (modal).
- **Matcher / Client** (`client/`): participant code. Each client connects to one session.

## 2. File Structure

| File | Role |
|------|-----|
| `src/config.ts` | Tunable parameters (with env overrides) |
| `src/types.ts` | Shared types |
| `src/geometry.ts` | Distance, movement, rating function |
| `src/world.ts` | World state + single-step logic |
| `src/engine.ts` | Session loop + assignment buffer + optional internal matcher (`autoMatch`) |
| `src/session-manager.ts` | Management of multiple concurrent Engines |
| `src/server.ts` | HTTP REST server + WebSocket (matcher) + serving the UI |
| `public/` | UI grid + modal |
| `client/sample-client.ts` | Reference Matcher (per-session) |

## 3. The cycle (in each Engine)

The engine is **event-driven** — there is no fixed clock. A cycle runs as soon as the matcher submits its answer (full speed):
1. The Matcher submits its assignments for the current snapshot (`POST /assign` or a WS message).
2. The Engine applies them, then `world.step()`: movement, pickup, rating, completion, cancellation, sleep/wake, request generation.
3. A new snapshot is published and the per-cycle safety timeout is re-armed.
4. `tick >= SESSION_TICKS` ⇒ status = `finished`.

If the matcher does not answer within `CYCLE_TIMEOUT_MS`, the Engine advances anyway with whatever assignments it has (possibly none), so a slow/dead client can't stall the session. The real measured cycle duration is reported to the UI (as `cycleMs`) so the live animation stays in sync.

## 4. API

Base: `http://localhost:8080` (or `PORT`). JSON, open CORS.

### Auth
Every session belongs to a registered user; the matcher client identifies itself with the user's **API token** (`Authorization: Bearer <token>`, or `?token=` for WebSockets).

| Method and path | Action |
|-----------|-----|
| `POST /auth/register` | body `{ username, password }` → `{ id, username, token }` |
| `POST /auth/login` | body `{ username, password }` → `{ id, username, token }` |
| `GET /auth/me` | with token → `{ id, username, token }` |

### Session Management
| Method and path | Action |
|-----------|-----|
| `POST /sessions` | **Requires token.** Create a session owned by the token's user. → `{ id, creator, status }` |
| `GET /sessions` | List of all worlds — an array of full vizState (public, for the UI grid) |
| `DELETE /sessions/:id` | Delete a session (owner only) |
| `POST /sessions/:id/start` | Start/resume (owner only) |
| `POST /sessions/:id/reset` | Reset (owner only) |

### Results (public — anyone can see every submission)
| Method and path | Action |
|-----------|-----|
| `GET /leaderboard` | One row per player (their best run), ranked by revenue |
| `GET /results` | Every finished session, newest first |
| `GET /results?user=<id>` | A single player's finished sessions |
| `GET /replays/:id` | A finished run's frame-by-frame recording for visual playback (`{ id, replay: { creator, world, stepPerCycle, sessionTicks, frames } }`) |

### Matcher Interface — WebSocket (recommended)
`ws://host/sessions/:id/ws?token=<your token>`

- The owner's token is required (query param). Connecting without it is rejected (401).
- Opening the socket = "matcher connected" → a waiting session **starts**.
- Every cycle, the server **pushes** a snapshot: `{ id, status, tick, idleDrivers, openRequests, config, … }`.
- The client replies with a message: `{ "tick", "assignments": [{ "driverId", "tripId" }] }`.
- No polling; one persistent connection instead of hundreds of requests. (The sample client uses exactly this.)

### Matcher Interface — REST (alternative)
| Method and path | Action |
|-----------|-----|
| `GET /sessions/:id/state` | Decision-ready snapshot: `idleDrivers` + `openRequests` + `config` + `tick` |
| `POST /sessions/:id/assign` | body: `{ "tick", "assignments": [{ "driverId", "tripId" }] }` |
| `GET /sessions/:id/viz` | Full state of one world (all drivers + trips + scoreboard) |

- The first `GET /state` also starts a waiting session (like opening the socket).
- Response of `/assign`: if `tick` is stale → 409.
- `viz`/`/sessions` include `stepPerCycle` and `cycleMs` so the UI can predict the animation accurately and in sync.

> Performance: completed/cancelled trips are pruned from memory, so the cost of each snapshot stays constant and does not slow down over the course of a session.

## 5. Running

```bash
npm install
npm run engine         # 30-second cycle (real competition)
npm run engine:fast    # 5-second cycle (demo/development)
npm run client         # one Matcher that creates and drives a new world itself

# Multiple concurrent worlds with an external matcher:
SESSION_ID=s2 npm run client    # connect to the existing world s2

# UI: http://localhost:8080/  →  "New world (auto)" or connect clients
```

Tune with env: `CYCLE_MS`, `DRIVER_SPEED`, `RIDER_ARRIVAL_RATE`, `DRIVER_COUNT`, `SEED`, …

## 6. Fairness and Reproducibility

- All sessions are created with the same `SEED` ⇒ the initial positions of drivers and the sequence of requests are identical.
- For ranking: each participant runs on a separate session with the same seed; then the `scoreboard`s are compared.

## 7. Remaining Work (Roadmap)

- [ ] Tune parameters (speed, arrival rate, fare) — currently placeholder.
- [ ] Final competition scoring formula + display of ranking across sessions.
- [x] User accounts + token auth; sessions are owned by a user (only the owner can drive/reset/delete).
- [x] Per-player leaderboard; all submissions are publicly visible.
- [x] Event-driven full-speed cycle with a per-cycle safety timeout.
- [x] Per-run recording + visual replay (`/replays/:id`, `replay.html` with play/pause/seek/speed).
- [ ] Session persistence (live sessions are in-memory and wiped on restart; results + replays are stored in Postgres).
- [ ] Headless/batch mode for automatically running multiple seeds.
