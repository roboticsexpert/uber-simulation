# Matching Competition — Uber Simulation

> Game Design Document
> Version: 0.1 — initial draft

## 1. Overall Idea

We are running a coding competition. Each participant implements only and exactly the **Matching algorithm**:
deciding "which driver should be assigned to which trip request."

The **platform** runs everything else in the simulation (world, time, movement, fare, scoring). Participants' code runs in the same world with the same inputs and is ultimately compared against others based on a **shared scoring metric**.

```
┌──────────────────────────────────────────┐
│              Platform (Engine)            │
│  world, time, driver movement, fare, rating │
│                                            │
│   each tick ─►  ┌────────────────────────┐  │
│   world state   │  Participant's Matcher  │  │
│                 │  (produce an assignment) │  │
│   ◄── assignment └────────────────────────┘  │
└──────────────────────────────────────────┘
```

---

## 2. Entities

### 2.1. Driver

| Property | Description |
|------|-------|
| `id` | Unique identifier |
| `location` | Current position on the map |
| `state` | One of the three states below |
| `rating` | Average rating received from trips (optional, for display) |

**Driver states (`state`):**

- `IDLE` — waiting for a trip (can receive an assignment)
- `ON_TRIP` — currently on a trip (includes the route to the rider + the route to the destination)
- `OFFLINE` — inactive / sleeping (cannot receive an assignment)

**Driver behavior:**

- The driver accepts **every trip** we give them (in this version the driver cannot reject).
- If a driver gets no trip for **30 minutes**, they go `OFFLINE` ("fall asleep").
- After **1 hour** of sleep, the driver returns to `IDLE`.

> Note: the 30-minute timer counts from the last trip taken; every new trip resets it.

### 2.2. Rider

| Property | Description |
|------|-------|
| `id` | Unique identifier |
| `location` | Origin position (where they make the request) |
| `destination` | Destination position |
| `requested_at` | Time the request was made |

**Rider behavior:**

- A rider submits a trip request with a **specific destination**.
- A rider waits at most **5 minutes**. These 5 minutes are counted from the moment of the **request** to the moment the **driver reaches them (pickup)**.
- If the driver does not reach them within 5 minutes, they **cancel the trip** — whether no assignment was ever made, or a driver was assigned but arrives late.

> Example: if at minute 1 they are connected to a driver but the driver takes 5 minutes to arrive (arriving at minute 6), the rider cancels because the 5-minute cap has been exceeded.

---

## 3. World and Time

### 3.1. Map and Location

- Each entity's position is a point on the map: `(x, y)`.
- The **distance** between two points is computed with a defined distance function (suggested default: Euclidean distance).
- **Trip time** = distance ÷ driver speed. (A constant, identical speed is assumed for all drivers.)

> 🔧 Open parameter: the map model (continuous coordinates or grid) and the distance function (Euclidean or Manhattan) should be finalized in the platform document — section 7.

### 3.2. Simulation Time

- The simulation advances in discrete **ticks**; each tick is one unit of time.
- The logical unit of time is the "minute" (all the rules above are expressed in minutes).
- On each tick:
  1. The platform gives the world state to the Matcher.
  2. The Matcher returns the assignments.
  3. The platform moves the drivers, processes arrivals/cancellations/completions, and records the scores.

---

## 4. Trip Lifecycle

```
REQUESTED ──(assignment by Matcher)──► ASSIGNED ──(driver reached rider)──► PICKED_UP
   │                                     │                                  │
   │ 5 minutes passed without pickup     │ 5 minutes passed since request   │
   ▼                                     ▼                                  ▼
CANCELLED                            CANCELLED                          IN_TRANSIT ──► COMPLETED
```

- **REQUESTED**: request submitted, waiting for assignment.
- **ASSIGNED**: a driver has been assigned and is en route to the rider.
- **PICKED_UP / IN_TRANSIT**: the rider is on board, the driver heads toward the destination.
- **COMPLETED**: the trip reached the destination.
- **CANCELLED**: the rider gave up before pickup (the 5-minute cap).

---

## 5. Fare and Scoring

### 5.1. Trip Fare

```
fare = BASE_FARE + (PER_DISTANCE × distance(origin, destination))
```

- `BASE_FARE`: the fixed base cost of each trip.
- `PER_DISTANCE`: cost coefficient per unit of distance.
- `distance(origin, destination)`: the distance between the origin and destination points (not including the driver's route to the rider).

### 5.2. Rider Rating of the Trip (Rider Rating)

Based on **wait time** = from the moment of the request to the moment the driver arrives (pickup):

| Wait time | Rating |
|------------|:-----:|
| Less than 1 minute | ⭐ 5 |
| Up to 2 minutes | ⭐ 4 |
| Up to 3 minutes | ⭐ 3 |
| Up to 4 minutes | ⭐ 2 |
| More than 4 minutes | ⭐ 1 |

> Cancelled trips never reach the pickup stage, so they have no rating (section 6 clarifies how they affect the competition score).

### 5.3. Driver Rating of the Trip (Driver Rating)

Based on the **driver's arrival time to the rider** = from the moment of assignment to the moment of pickup:

| Arrival time | Rating |
|------------|:-----:|
| Less than 1 minute | ⭐ 5 |
| Up to 2 minutes | ⭐ 4 |
| Up to 3 minutes | ⭐ 3 |
| Up to 4 minutes | ⭐ 2 |
| More than 5 minutes | ⭐ 1 |

**Key difference between the two ratings:**
- The rider rating is counted from the moment of the **request** (includes matching delay + arrival route).
- The driver rating is counted from the moment of **assignment** (only the arrival route).

So a good Matcher must both assign quickly (in the rider's favor) and pick the nearest driver (in favor of both).

---

## 6. Competition Goal and Scoring Metric

The participant's goal: write a Matcher that produces the **best service quality** over a given scenario.

Signals from which the competition score can be built:

- The number of **completed** trips (the more the better).
- The number of **cancelled** trips (the fewer the better).
- The sum/average of the **rider rating**.
- The sum/average of the **driver rating**.
- (Optional) The total **revenue** (fare of completed trips).

> 🔧 Open decision: the exact formula for the final competition score must be finalized. One simple proposal:
> ```
> score = Σ(rider_rating + driver_rating for completed trips) − (PENALTY × number of cancellations)
> ```
> This is marked as an open decision in section 7.

For **fairness**, all participants run on **identical scenarios** (the same request sequence, the same initial driver positions, the same random seed).

---

## 7. Parameters and Open Decisions (for the Platform Document)

These items were intentionally left open in the game design and must be finalized when building the platform:

| # | Item | Suggested Default |
|---|------|----------------|
| 1 | Map model (continuous vs grid) and distance function | continuous coordinates + Euclidean distance |
| 2 | Driver speed (distance units per minute) | must be set to a value |
| 3 | `BASE_FARE` and `PER_DISTANCE` | must be set to a value |
| 4 | Tick length (how many minutes per tick) | 1 tick = 1 minute (or finer for precision) |
| 5 | Exact threshold logic (`<` vs `≤`) in the ratings | the tables in section 5 are the reference; boundaries must be made code-exact |
| 6 | Final competition score formula + cancellation `PENALTY` | section 6 |
| 7 | How requests and scenarios are generated (arrival rate, position distribution) | must be designed |
| 8 | Can a single driver have multiple assignments at once? | No — one trip per driver |
| 9 | Time/resource limit for running Matcher code per tick | must be set to a value |
| 10 | Driver rating behavior for the "4 to 5 minutes" threshold (not explicit in the original description) | assumption: 4 to 5 → 1 star, following the trend |

---

## 8. Matcher Interface Contract (Conceptual Draft)

This is merely the conceptual shape; the exact signature is defined in the platform document.

**Input of each call (on each tick):**
- The current simulation time.
- The list of `IDLE` drivers with their `id` and `location`.
- The list of open requests (`REQUESTED`) with `id`, `location` (origin), `destination`, `requested_at`.

**Output:**
- A list of `(driver_id, request_id)` pairs as assignments.
- The platform rejects invalid assignments (busy driver, expired request, duplicate assignment).

---

## 9. Rules Summary (Cheat Sheet)

- 3 driver states: `IDLE` / `ON_TRIP` / `OFFLINE`.
- The driver accepts every trip.
- No trip for 30 minutes → sleep; awake after 1 hour.
- The rider has a 5-minute wait cap (request to pickup); after that, cancel.
- `fare = BASE_FARE + PER_DISTANCE × distance from origin to destination`.
- Rider rating: a function of time (request→pickup); 5→4→3→2→1 for 1→2→3→4→more minutes.
- Driver rating: a function of time (assignment→pickup); 5→4→3→2→1 for 1→2→3→4→5+ minutes.
