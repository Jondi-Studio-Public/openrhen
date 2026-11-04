---
name: openrhen-concepts
description: What an area, outcome, project, action, commitment, capture, condition, routine and deliverable are in the owner's OpenRhen, how they nest, and which one to create for what they said. Read before creating a record, or when unsure what a word means.
metadata: {"openclaw":{"emoji":"🧭"}}
---

# What the pieces are

OpenRhen has two sides. The **work side** is a hierarchy that says why something matters. The **time side**
says what time exists and what already occupies it. The engine combines them into the one directive on Now.

## The work side (top is "why", bottom is "what next")

```
area         an ongoing part of life: Health, Study, Home. Never finished.
  outcome    a result with a finish line ("Pass the anatomy exam").
    project  a bounded piece of work that advances one outcome.
      action the next concrete, startable thing ("Draft section 2").
deliverable  sits beside actions inside a project, for work that needs its own plan.
```

- **Area.** A container and a balancing signal, not a task. Fields: name, description, status, and a private
  flag (hides everything under it from the published pulse). Create one rarely; most of their life already fits
  an area they have. Search first.
- **Outcome.** One area, a title, a **definition of done** (what "finished" means; required), a value from 1 to
  5 (how much it matters), and an optional deadline and review date. An active outcome should have at least one
  project or action advancing it.
- **Project.** One outcome, a title, an **internal deadline** (when they want it done) and an **external
  deadline** (the true outside one, such as a due date set by someone else), **uncertainty** (known, some, high)
  and **consequence** from 1 to 5. A project with no concrete next action is a planning problem: the engine
  has nothing to recommend from it, so add an action or ask them what the first step is. Never invent one.
- **Action.** The smallest unit that starts without more planning; it begins with a verb. It records its project,
  three estimates (optimistic, expected, pessimistic minutes), remaining minutes, the energy it needs, where or
  with what it can be done (requirements), session length limits, whether it can be split, importance and
  consequence from 1 to 5, and an optional due date. **No due date means open work**: offered when there is
  slack, never overdue. Status is inbox, planned, active, doing, waiting, blocked, done, cancelled or archived;
  only ready actions in active projects and outcomes compete for the recommendation.
- **Deliverable.** A finishable, reviewable body of work in one project, such as an assessment, a report or a
  submission, that is too big to be one action. It has a completion contract (required outputs and criteria), an
  internal step plan with prerequisites, and blockers. Its method is always Breakdown, then Carry out, then
  Review. Use a deliverable when "done" needs checking against criteria; use an action when it does not. The
  engine can recommend a deliverable, and the owner presses Start from Now to open its workspace and time it.
  To drive one (breakdown, steps, review, blockers) read `openrhen-deliverables`.

Pick the level from what they said. If two rows fit, or none, ask them one question; do not guess:

| They say | It is |
| --- | --- |
| "I want to be healthier" | an area (probably existing) or an outcome with a definition of done |
| "I need to pass the exam by June" | an outcome, with a project under it for the work |
| "Write the lab report" | a project if they say it has several steps, a deliverable if they say there are criteria to check, an action if neither; ask when unclear |
| "Email the tutor" | an action |
| "Dentist Tuesday 9am" | a commitment, not an action |
| "Remind me to look into X sometime" | a capture |

Prerequisites: action-to-action and deliverable-to-deliverable ordering is `dependencyIds`; anything involving
a project, or mixed kinds, is a `{kind,id}` entry in `prerequisites`. Loops are refused.

## The time side

- **Commitment.** Time already taken: a class, appointment, meal, meeting. Status confirmed (blocks time),
  tentative, or cancelled (no longer blocks). It can carry setup-before and transition-after buffers and a place.
  A **recurrence rule** is the pattern behind a repeating commitment; editing the rule changes every future
  occurrence, editing one occurrence changes only that day. Ending a series is setting its end date, not a status.
- **Routine.** Preparation steps attached to a commitment (pack the bag) or a night's sleep. A preset is the
  reusable template.
- **Capacity window.** Time that may be used for work, with an energy level. Usually derived from what is free.
- **Sleep plan.** A planned or recorded night; see `openrhen-sleep`.
- **Condition.** What "where I am and what I have" means to an action's requirements: a saved place, a portable
  capability, a contact, or a live window tied to a recurring commitment. Requirements are routes: everything in
  one route is needed together, any satisfied route is enough.

## The inbox side and the live side

- **Capture.** Unprocessed information that changes nothing until reviewed. Use it when they give a thought with
  no detail; see `openrhen-inbox`.
- **Session.** Tracked work with a start, optional pauses and an outcome. **Check-in**: their answer to "are you
  on track?". **Disruption**: something unplanned that took their time. See `openrhen-sessions`.
- **Directive.** The engine's answer to "what now": the thing, how long, why. Never re-rank it.

## Traps

- Do not put a feeling or private context in a record; write the plan change it implies.
- Do not create a project to hold one action, or an area for one outcome, without asking.
- Search before you create (`rhen_search` with `like`, or `status` `any` for finished things) so you do
  not duplicate.
- Read the input schema of `rhen_save_project` and `rhen_save_action` for exact field names before
  the first write; for areas and outcomes read the `writing-data` topic of `rhen_guide`.
