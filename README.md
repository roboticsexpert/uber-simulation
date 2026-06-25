# 🚕 Uber-Sim — Matching Arena

A coding-competition platform: participants write a **Matching** algorithm (assigning drivers to riders) inside a live Uber simulation.

## Quick Start

```bash
npm install
npm run engine:fast     # engine + UI on http://localhost:8080  (fast cycle for testing)
npm run client          # in another terminal: sample Matcher
```

Then open `http://localhost:8080/` and click **▶ Start**.

To run a real competition use `npm run engine` (cycle = 30 seconds, session = 2 hours).

## What is this?

- The **Engine** simulates a world of drivers and riders and advances it each cycle.
- The **UI** shows the live map (drivers, requests, scoreboard).
- The **Matcher** is the participant's client: it fetches `GET /state`, makes a decision, and sends `POST /assign`.

Participants only change the `decide()` function in [`client/sample-client.ts`](client/sample-client.ts) (or call the same two endpoints in any language).

## Documentation

- 📖 [Game Rules](docs/GAME_DESIGN.md) — driver, rider, fare, rating, sleep.
- 🔧 [Platform Architecture and API](docs/PLATFORM.md) — endpoints, the cycle loop, running, tuning.

## Status

An early working version. The parameters (speed, arrival rate, fare) are currently placeholders and tunable via env — see the roadmap in the platform document.
