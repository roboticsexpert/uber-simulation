# 🚕 Uber-Sim — Matching Arena

A coding-competition platform: participants write a **Matching** algorithm (assigning drivers to riders) inside a live Uber simulation.

## Quick Start

```bash
npm install
npm run engine:fast     # engine + UI on http://localhost:8080
```

Then open `http://localhost:8080/`, **register** (username + password) to get your **API token**, and start a matcher with it:

```bash
TOKEN=your_api_token npm run client      # in another terminal: sample Matcher
```

## What is this?

- The **Engine** simulates a world of drivers and riders and advances it each cycle. It runs **at full speed**: the world steps forward the instant your matcher submits its answer (a safety timeout advances it if a client stalls).
- The **UI** shows the live map (drivers, requests, scoreboard) and a **per-player leaderboard**. Every finished session is public for all to see.
- The **Matcher** is the participant's client: it fetches `GET /state`, makes a decision, and sends `POST /assign`.

**Accounts:** every session belongs to a logged-in user. Register on the website to get an **API token**; the client passes it (env `TOKEN`) so each run is provably tied to your account and lands on your scoreboard.

Participants only change the `decide()` function in the sample clients (or call the same two endpoints in any language).

## Documentation

- 📖 [Game Rules](docs/GAME_DESIGN.md) — driver, rider, fare, rating, sleep.
- 🔧 [Platform Architecture and API](docs/PLATFORM.md) — endpoints, the cycle loop, running, tuning.

## Status

An early working version. The parameters (speed, arrival rate, fare) are currently placeholders and tunable via env — see the roadmap in the platform document.
