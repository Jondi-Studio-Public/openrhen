# Engine logic

This is the exact, deterministic logic behind a plan. The engine (`engine/core`) is a pure function: for a supplied state and calculation time it returns the same forecasts, ranking and explanation every time. All ordering ends in a stable identifier tie-break, so array order, row order, locale and timing never change a result.

## 1. Pipeline

```text
state + calculatedAt
  -> sleep, routines, recurrence, capacity
  -> compatible slots and envelopes
  -> protected effort and dependencies
  -> backward reservation from deadlines
  -> project health and latest safe starts
  -> filter and rank what is possible now
  -> one directive
  -> continuation on request
```

One scheduling result feeds forecasts, recommendations, continuation and explanation; no consumer recomputes a competing capacity.

**Inputs:** the calculation time, timezone, forecast horizon and daily boundary; projects, actions, estimates, dependencies, statuses, deadlines and focus; the usable fraction, commitments and buffers; current energy, the condition catalogue and your situation (location, carried capabilities, transport modes); sleep preferences and history, routines and recurring rules; session state; and estimate calibration.

**Outputs:** slots, allocations and reservations; per-project forecasts (margin, confidence, blocked effort, pace, latest safe start); ranked candidates with exclusions, tier, score components, session length and a structured reason; one directive; continuation safety; the week outlook and day plan.

## 2. Time and capacity

Time ranges are half-open `[startsAt, endsAt)`. Wall-clock rules use the configured IANA timezone. Durations are whole minutes. A repeated fall-back time takes its second occurrence; a spring-forward gap moves past the gap.

**Capacity is derived, never stored.** There is one window per local day, clipped to now and the horizon, scaled by your usable fraction. Recovery windows, commitments and sleep shrink it. Sleep is subtracted, not excluded: planned sleep is a protected commitment, with one assumed night per day beyond it, so a longer horizon cannot inflate daily capacity.

**Graduated horizon.** The default horizon is 180 days (maximum 366). Precision falls with distance:

| Days from now | Kind | Capacity factor | Confidence |
|---|---|---:|---|
| 0-7 | detailed | 1.00 | high |
| 7-14 | daily | 0.90 | medium high |
| 14-30 | weekly | 0.80 | medium |
| 30-90 | fortnightly | 0.65 | low medium |
| 90-180 | monthly | 0.50 | low |

The detailed band uses exact 15-minute slots; later bands aggregate capacity with explicit confidence. Dated commitments stay protected in every band.

**Energy.** `high` capacity satisfies high, medium or low work; `medium` satisfies medium or low; `low` only low; `recovery` only recovery. Future energy is `unconfirmed`: forecasts use it and say so. The immediate recommendation also checks your current energy, except for recovery work, which needs none.

## 3. Conditions

A condition is a location, a capability, a contact, or a live commitment. Settings owns the catalogue; the Now screen holds your current situation; one matcher serves scheduling, ranking and the portal.

Work states requirement **pathways**: all requirements inside a pathway are needed together, and any one satisfied pathway is enough. Stating no pathway states no requirement. **Preferences** never affect eligibility; they only shade fit.

Every condition resolves to `yes`, `no` or `unknown`:

- A location is `yes` where you are, `no` elsewhere, and `unknown` while your location is unknown, including when your last assertion is older than the staleness limit (default 480 minutes).
- A manual override outranks inference.
- A portable capability is answered by what you carry; unstated is `unknown`.
- A contact reachable by message or call is `yes` anywhere; one with no channel is `unknown`.
- A live-commitment condition is `yes` only while a confirmed occurrence is running (never its buffers). The clock settles it, so it is never `unknown`.
- An undefined or archived condition is `no`.

A pathway is satisfied when every requirement is `yes`; it is unknown when some are unknown and none are missing; otherwise it is unsatisfied. Both unknown and unsatisfied exclude the work, but they are reported differently: **unanswered** work is excluded only by a question worth asking, and **reachable** work is excluded only by being elsewhere, so it can be offered as a trip. Work blocked only by a live-commitment condition carries a hold that names what it is waiting for and, when known, when it next starts.

## 4. Effort

```text
baseline          = max(1, expectedMinutes ?? remainingMinutes)
pertExpected      = (optimistic + 4 * baseline + pessimistic) / 6
standardDeviation = (pessimistic - optimistic) / 6
protectedOriginal = pertExpected + 1.04 * standardDeviation        when a range is stated
protectedOriginal = baseline * project uncertainty multiplier      otherwise
```

Default multipliers are 1.15 (known), 1.35 (some uncertainty) and 1.60 (high). Remaining effort scales the protected estimate once:

```text
protectedRemaining = ceil(protectedOriginal * remainingMinutes / baseline) + setup
```

Setup applies only while work remains. A project total is the sum of the means plus `1.04` times the square root of the summed variances. A project-level override replaces the derived total.

**Learned calibration.** Finished one-off actions with recorded sessions give a ratio of time run to effort removed. Folded in oldest first, `factor = 0.25 * ratio + 0.75 * factor`, clamped to 0.75-2.50. An area uses its own factor from five samples, else the overall factor, else none. It scales the mean once. It can be switched off in Settings.

## 5. Dependencies and deliverables

Dependency analysis validates references and cycles, then gives a stable topological order; either error prevents forecasting that work. Longest-successor-path minutes break ranking ties. Blocked actions, and everything downstream of a blocked, waiting or unplaceable prerequisite, hold effort as a held-back chain; resolvable siblings forecast at lower confidence.

A **deliverable** is a recommendation target alongside actions, with a completion contract and a step plan. The engine plans against a deterministic projection only: aggregate remaining effort, approval state, minimum useful session, eligibility, dependencies and the earlier of its deadlines. It never sees criteria, blockers, sources or chat. A deliverable whose breakdown is unapproved has unknown effort, not zero, so it stays rankable and opens its workspace at Breakdown.

## 6. Deadlines and allocation

The **internal deadline** is the explicit one when present, capped at the external deadline; otherwise it is the external deadline less the larger of a submission buffer (default 60 minutes) and 10 percent of protected effort. A project with neither deadline nor review focus is *Unknown*.

**Reservation.** A standing pass first reserves every live recurring series. Projects then reserve capacity in order of internal deadline, then identifier, and the forecast records gross, already-reserved and remaining capacity. Within a project each action is placed tail-first (the latest compatible time before its boundary) in backward dependency order. Placement respects energy, conditions, session bounds, splittability, setup, availability and deadline boundaries; an indivisible action must fit continuously. A run that reaches its maximum session owes a break.

**Latest safe start** is the earliest start among an action's backward blocks. Waiting past it consumes margin and may make the work deadline-critical.

```text
expected margin    = available compatible capacity - protected remaining effort
pessimistic margin = available compatible capacity - pessimistic remaining effort
margin ratio       = expected margin / max(protected remaining effort, 1)
```

If margin is non-negative but protected work remains unplaced, there is enough time but not the right shape; this is reported apart from a shortage.

## 7. Project health

Health is one of ahead, on track, at risk, behind or unknown, taken from margin, confidence, blocked effort and pace. A pace line compares work finished against how much of the run to the deadline has elapsed. A project made only of habits is judged on **adherence** (sessions done against sessions due), not on the deadline ladder.

## 8. The current recommendation

**Hard precedence.** A protected commitment wins before ordinary ranking, unless the person said they are free of it (`freedFrom`): a freed commitment is released like an open anchor for the live ranking, while forecasts and the day plan stay pessimistic and still draw the block. Failing that, sleep and routine directives precede ordinary actions. Deliberate recovery is the directive only when nothing fits inside an open recovery window. A journey to a located commitment, or home for sleep, is protected additively: setup, travel, an arrival margin, the commitment, then its transition and the leg on.

**Travel.** Journey time comes from the best available source in order: a live sample under 30 minutes old, past trips for the same pair, mode and time of day, any past trips for the pair and mode, the destination's stored minutes, then a straight line. The figure is the 95th percentile when lateness matters (the default) and the 80th otherwise, never below the median.

**Eligibility.** An action is excluded when its project is inactive; another session is active; it is not yet available or its latest useful start has passed; a dependency is incomplete; no requirement pathway is satisfied; your current energy is incompatible; the compatible window is shorter than its minimum session; or it is resting after a maximum-length session. Session length in focused minutes is the smallest of the risk-adjusted remaining effort, the maximum session, and the compatible time before the horizon or next protected boundary.

**Deadline-critical ladder.** Eligible candidates sort ahead of ineligible ones, then by tier:

| Rank | Tier |
|---:|---|
| 0 | overdue, external deadline |
| 1 | behind, external |
| 2 | at risk, external |
| 3 | behind, self-set |
| 4 | at risk, self-set |
| 5 | due this week, external |
| 6 | ordinary: weighted ranking |

A passed self-set date cannot be recovered by working, so it ranks as ordinary and is offered a new date.

**Ordinary weighted ranking** scores these components, in maximum points: capacity pressure 30, consequence 15, outcome value 15, importance plus or minus 1, neglect 12, momentum 10, energy fit 8, completion potential 10, switching cost minus 10, avoidable travel minus 15, cadence due 40, and a self-set deadline this week 45 (30 when the project's health is unknown). Requirement pathways are a hard filter, never a score. Area balance is deliberately not a component. Ties go to the earlier deadline, downstream minutes, lower margin ratio, higher consequence, completion potential, then identifier.

**Comparison-refined consequence.** A project or action may carry a refined consequence, a real number from 0 to 6 fitted from ranked-group answers (`fitConsequence`: a deterministic, bounded MAP Plackett-Luce fit with the stars as a prior, each value held within one star of its stars). The ordinary tier alone reads it, in the consequence score component and the ordinary tiebreak; in the score component each input is clamped to 1-5 separately and mixed 0.6/0.4 as before, so the component keeps its 0-15 range and no weight changes, while the tiebreak uses the same mix unclamped (inputs bounded to 0..6) so refined values beyond the stars scale still order. Deadline-critical tiers and continuation stay on stars only, and a record with no refined value ranks exactly as before. The state carries `consequenceRefinedForStars` beside the value, and the engine ignores a refined value whose stars no longer match, so a star edit wins at once. The database layer stores it: answers go into an append-only log (`consequence_comparisons`, with the groups handed out in `consequence_groups_issued`) whose item ids have no foreign key to projects or actions, and the refined value, its `for_stars` and its `as_of` day are columns on `projects` and `actions` that no ordinary save writes. `refitConsequence` (`platform/database/src/consequence/refit.ts`) recomputes them as a pure function of the log, the items' current stars, status and a hash of their material fields (trimmed title, definition of done, both deadlines, parent id) and the local day: an answer is dropped whole when any item's stars or hash differ from those stored with it, a finished or closed item just leaves its answers, the weight is `0.5^(age_days/180)` in whole local calendar days times 1 for stated or observed and 0.5 for inferred answers, and inferred weight is capped per item per day and in total so repeated agent guesses cannot reach the one-star bound. `for_stars` is overwritten with the current stars on every fit, and an item left with no usable answer has all three columns set to null. One transaction under a per-user, per-pool advisory lock does the refit, and a failure leaves the previous values. It runs after every answer, inside every whole-state replace and import commit, after a restore, and when a plan is built on a later day than the stored fit. The next group is the highest-variance item and its three nearest neighbours by value (projects with projects, actions with siblings of one project), never repeating a pair asked in the last 30 days, and never private items for an agent.

## 9. Continuation

Continuing past a session's end is bounded by the maximum session, remaining effort and the current compatible window. Candidates are the maximum duration, the minimum, and descending 15-minute checkpoints, each simulated as reduced effort plus a protected commitment from now. The longest candidate that does not turn a feasible earlier-deadline or higher-consequence project *Behind* wins.

## 10. Sleep, routines and recurrence

**Sleep is a wall.** The engine never shortens a night for work. For each night it tries each move (stay, walk back, start after a conflict plus the routine, or truncate) and ranks them by the awake limit, the minimum, more sleep, then closeness to the preferred bedtime. Past the configured deviation the night warns and offers the nearer alternative. Only a confirmed commitment can force a night below the minimum, and the shortfall is shown.

**Routines.** A bedtime routine schedules steps immediately before the sleep plan; a wake routine runs forward from waking. Commitments carry their own preparation steps. The engine places every chain from one commitment timeline, so no consumer does its own buffer arithmetic. A wait holds no capacity and ends before its dependants; a flexible step may be done early but never displaces deadline-critical work. **Prep pace** reports whether getting ready keeps up with the clock for the next commitment: `behind`, `tight` (under five minutes spare) or `on track`.

**Recurrence.** A cancelled occurrence of a recurring commitment protects nothing. An occurrence may carry a per-date edit that a series change leaves alone. Recurring actions resolve occurrences from wake, sleep-start or clock anchors with fallbacks. A **cadence** is a recurring action with no windows: suggested, never required. Dueness is whole local days since the last completion over the interval, or, for a period rule, the remaining target over the days left. Cadence stays in the ordinary tier, so deadline-critical work always wins, and a cadence reserves no capacity.

## 11. Explanation and recalculation

Every forecast explains effort, capacity, earlier reservations, margin or shape failure, blocked effort, pace and confidence. Every recommendation retains eligibility failures, its tier and reason, the strongest score components, the session boundary, the effort method, and a structured reason covering the runner-up and what would change the answer (a different location, high energy, a longer slot).

When nothing fits, the result names what would resolve it: either one unanswered condition, or a boundary (too little time before the horizon, a commitment, sleep or a capacity opening) with the first thing that fits after it.

A result is valid until its earliest boundary: the daily horizon, a commitment, sleep, a capacity transition, a latest safe start, or the validity ceiling. A material change or boundary enqueues a recalculation; see the [architecture overview](../architecture/overview.md).

## 12. Properties the tests protect

Removing capacity cannot improve feasibility. Adding work cannot increase margin. Allocations never precede their dependencies. Overlapping windows do not borrow incompatible labels. Later confidence bands create no extra daily capacity. Re-estimation scales once. Closer deadline risk outranks distant preference. Blocked effort does not erase resolvable work. Due cadence never outranks deadline-critical work and never repeats within a day.
