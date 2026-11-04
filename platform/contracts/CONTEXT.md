# Planning contracts

The shared language of the workspace. Every other package imports these types, so a word defined here means the same thing in the engine, the database layer, the portal and the CLI.

This file is a glossary. Behaviour lives in the design notes, storage in the design notes, and decisions in the design notes.

## Language

### The work hierarchy

**Area**:
A standing part of life that work belongs to. It is never completed and never ranked.
_Avoid_: Category, bucket, tag.

**Outcome**:
A result worth reaching, owning the projects that get there. Its being active is what makes its projects eligible.
_Avoid_: Goal, objective, epic.

**Project**:
A body of work with an end state, owning actions and deliverables and carrying the deadlines, value and consequence ratings that rank them.
_Avoid_: Initiative, workstream.

**Action**:
The smallest visible, startable unit of work, belonging to exactly one project. There is one kind of action. What varies is the schedule attached to it — a due date, a recurrence, or a cadence (below) — and the mode never becomes part of the noun: "recurring action" and "regular action" are descriptions, not terms. A deliverable's steps are actions that belong to that deliverable, stored in the same `actions` table (`deliverable_id`).
_Avoid_: Task, todo, item, deliverable step, variable commitment.

**Deliverable**:
A finishable, reviewable body of work belonging to one project, distinguished from an action by needing a planning step of its own and an explicit definition of done reviewed against evidence. The work inside it is actions.
_Avoid_: Artefact, document, submission.

**Commitment**:
Something that happens at a particular time and occupies the calendar rather than competing for it — the only record subtracted from capacity. A commitment may carry a recurrence, which then produces dated commitments rather than windows. Whether one is running right now is a **live** condition, not a commitment.
_Avoid_: Event, appointment, meeting.

**Attendance**:
How the person takes part in a commitment: `in_person` (the default) or `remote`. A remote commitment has no journey — the travel model plans no leg to it and leave-by never fires for it — and its `preferredLocationId` (the home desk, say) is a preference the planner honours when it can, never the requirement `locationId` is for an in-person one. `commitments.attendance`.
_Avoid_: Online, virtual, mode (a transport mode is how the person travels).

**Prep**:
An action attached to one commitment as the work of getting ready for it, so it is tied to the commitment rather than merely dated near it. `actions.prep_for_commitment_id`. Cancelling the commitment offers to cancel its open prep. Not a routine's preparation phase, which is timed steps around the commitment, not planned work.
_Avoid_: Preparation (that is the before phase of a routine), setup (a buffer in minutes), sub-task.

### What an action carries

`schedulingMode` says which shape the action repeats in — `one_off`, `recurring`, `cadence` — and the rest of this section is what each shape carries or produces.

**Once**:
An action worked until done and then finished. `schedulingMode = 'one_off'`. It is either due or open.
_Avoid_: One-off action (as a term), task.

**Due date**:
The date an action must finish by. The planner picks the moment before it; past it, the action is overdue. `deadlineAt`.
_Avoid_: Deadline (as a noun for the action), variable commitment, obligation.

**Open**:
A once action with no due date. It exists so a date is never invented to satisfy a field: open work is suggested when there is slack, and is never overdue. Decided 2026-09-12.
_Avoid_: Someday, backlog, undated (as a term).

**Latest start**:
The last moment starting still finishes by the due date. Normally derived from the due date and the estimate; the editor and the import sheet can also set it explicitly, and no live once action does. It drives the deadline tiers and the backward reservations. `latestStartAt`.

**Recurrence**:
A rule that repeats an action on a calendar in a stated timezone, with a start and an optional end, producing windows. `action_recurrence_rules`; the same noun names a commitment's `commitment_recurrence_rules`.
_Avoid_: Recurring (as a noun or a kind), recurring requirement, series.

**Window**:
A span inside a recurrence when the action must happen: offsets from an anchor — actual or planned wake, planned sleep, a local clock — with a clock fallback. `action_recurrence_windows`.
_Avoid_: Slot, reservation (a reservation is the engine's backward hold before a due date).

**Occurrence**:
One window on one day, with its own status: pending, completed, missed or cancelled. Every occurrence is due at its window's end, and it is the unit the engine plans — its `windowStartsAt`/`windowEndsAt` are the window's bounds, not a placed slot, and it competes for capacity rather than reserving it.
_Avoid_: Instance, event, and a commitment's repeat — that is a commitment.

**Cadence**:
A rhythm without windows — every N days, or N times in a period — suggested when time allows. Never missed, only overdue. `schedulingMode = 'cadence'`.
_Avoid_: Practice, habit, routine, regular (as a kind).

### Routines

**Preset**:
A reusable template of steps.
_Avoid_: Routine (a routine is a preset applied to something).

**Routine**:
A preset applied to an anchor: a commitment, or a night's sleep as its bedtime or wake routine. Both anchors store as `routineSteps` rows of the same shape — a commitment-anchored row carries `commitmentId`, a sleep-anchored one carries `anchorType`/`anchorId`/`purpose` instead.
_Avoid_: Checklist, practice, instance.

**Step**:
One timed part of a routine: a duration and a sequence, never an estimate range. The only thing called a step. Its phase is `before` or `after` the anchor: the before phase is **preparation**, the after phase is **wrap-up** (getting changed, the uniform in the wash, the extra meal).
_Avoid_: Task, item, action.

### The situation model

**Condition**:
A durable, user-defined thing that can be true of the person's environment, independently of any work wanting it — `home`, `desktop`, `Jane reachable`, `campus class, live`. Four kinds: location, capability, contact, live. A live condition holds while a named commitment is running. `ConditionDefinition`/`condition_definitions`; the requirement side's own `contextIds`/`context_key` fields are unaffected by that rename and keep their name.
_Avoid_: Context, tag, resource, state, fact.

**Requirement**:
An action's demand that certain conditions hold before it can be worked.
_Avoid_: Context, constraint, prerequisite (a prerequisite is a dependency on another action).

**Pathway**:
One alternative route to satisfying a requirement — every condition in a pathway must hold, and any one pathway satisfying it is enough. AND within, OR across.
_Avoid_: Option, variant, branch.

**Preference**:
A condition an action is better done under but does not need. A miss shades ranking and never blocks.
_Avoid_: Soft requirement, nice-to-have.

**Situation**:
Everything resolved at an instant — which conditions hold, the person's energy, and what is live: the running commitment or session, the routine in progress, the last check-in. Produced by `resolveSituation`, and the thing requirements are matched against.
_Avoid_: Context, state, status, snapshot.

**Reach**:
Whether a condition that does not hold here could be reached, and at what travel cost.
_Avoid_: Distance, availability.

**Pulse**:
Whether the person is on plan, off plan, free, or asleep right now, judged by `judgePulse` (`planning/pulse-judge.ts`) from a holding confirmation of whatever the plan currently sanctions — a session, a check-in answer, an arrival, a journey underway, or being asleep — and recorded as `pulse_segments` by the portal recorder. On plan: what they are doing and when it was last confirmed. Off plan: since when, and why (unconfirmed, deviated, unsanctioned, overran). Free: the plan directs nothing right now, so nothing is judged. Produced by `resolvePulse` (`planning/pulse.ts`), which fills `state`/`offPlanSince` from the recorder; most consumers pass it a candidate for whichever rank they have found current and read `doing` back rather than deriving it themselves — `check-in-scheduler.ts`'s belief still derives its own, richer reading, its kinds and fields having no `Pulse` equivalent, and it decides what to *ask* next, not whether the person is on plan, which `judgePulse`'s `expected` alone answers. Pulse is about the person and the plan, never about services, which stay under Diagnostics; the off wording is "off plan since", never "no pulse".
_Avoid_: Engagement, presence, footing, state, status, heartbeat.

**Pulse contact states**:
Built (`planning/pulse-state.ts`, `advancePulse`): `unknown` is a lapsed confirmation; `off/lapsed` is contact lost past a grace, or a deviation lacking what, until when, location, contexts or the exclusive flag, and is left only by all-or-nothing, undoable re-entry (`reenter`); meanwhile every agent call but `rhen_reenter` is refused. Thresholds are settings plus a per-commitment allowance; a `silent` shift or sleep freezes the clocks, and one that overruns by 60 minutes is off.

**Pulse shares**:
The percent of waking, non-free time recorded on plan, over today, 7 days, and 30 days — `null` below 15 counted minutes rather than a misleadingly precise rate. Distinct from Pulse itself, which never sums over time; shares are the one place a rate is deliberately computed, for the published object only.
_Avoid_: Score, uptime, streak.

### Judging work

**Consequence**:
How bad it is if a piece of work does not happen or fails. Carried by both projects and actions, combined as `0.6 × project + 0.4 × action`.
_Avoid_: Severity, risk, criticality.

**Value**:
What reaching a project's end state is worth. A project-level rating, and the only one that ranks projects against each other; an action's **importance** ranks it within its own project and never across.
_Avoid_: Priority, weight, score.

**Uncertainty**:
How well the size of the work is known: `known`, `some`, or `high`. It widens the effort range, and is not a confidence rating.
_Avoid_: Confidence, risk.

**Health**:
A project's standing against its own basis — `feasibility` when remaining effort must fit before a deadline, `adherence` when every live action is on a cadence or a recurrence and there is nothing to fit.
_Avoid_: Status (status is the lifecycle field), progress.

**Importance**:
How much an action matters relative to its siblings in the same project. It is not a priority, and it never ranks an action against work in another project.
_Avoid_: Priority, value, weight.

**Energy**:
The kind of attention a piece of work needs, or the person has: `high`, `medium`, `low`, `recovery`.
_Avoid_: Difficulty, effort (effort is minutes).
