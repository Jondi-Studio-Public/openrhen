---
name: openrhen-sessions
description: Starting, pausing, finishing and backdating work sessions in the owner's OpenRhen, answering check-ins, recording unplanned disruptions and "doing something else", arrivals and trips. Read when they start, stop or deviate from the directive.
metadata: {"openclaw":{"emoji":"🧭"}}
---

# Sessions, check-ins and disruptions

A **session** is tracked work: a start, optional pauses, and an outcome. Time only counts toward a project
while a session runs, so start one when they start.

## Sessions (`rhen_session`)

- `subcommand` is one of `start`, `alternative`, `pause`, `resume`, `continue`, `finish`, `block`,
  `did-not-start`, `feedback`, `set-start`.
- Start the current directive with `start`. To start something else on purpose, use `alternative` with the action
  (title or id), `minutes` and a `reason`. A recurring action's title or id picks its current occurrence; pass an occurrence id to be exact.
- `pause`, `resume`, then `finish` with an `outcome` (`completed`, `progress` with `remaining` minutes, or
  `unsure`). Passing `remaining` is what keeps the next answer honest: ask them how much is left, then send it
  as `remaining` in the `rhen_session` `finish` call.
- "I never started it" is `rhen_session` `did-not-start`; "I am stuck" is `rhen_session` `block` with a
  `reason` (and `status` if it is not `blocked`, for example waiting). Do not guess which; ask, then make that call.
- Backdating: `started-at` on a start (up to 24 hours back, never before the last wake or an earlier session);
  `set-start` corrects a session already running; `ended-at` on a finish says when it really ended ("I stopped
  lab 7 at 3"). A session nobody closed stops counting at its planned end and waits for feedback; `finish` with
  `ended-at` still says when it really ended, later than that only if they kept going.
- At a session's planned end, ask the owner what happened, then make the one call that matches their answer:
  - Done, stopped or part done: `rhen_session` `finish` with `outcome` `completed`, `progress` (plus
    `remaining`, the minutes still to do) or `unsure`, and `ended-at` if they stopped before the planned end.
  - Never started or stuck: `rhen_session` `did-not-start`, or `block` with a `reason`.
  - Keep going: `continue` works only on a session awaiting feedback, and a running one cannot be extended. If
    `rhen_status` shows the session running, call `rhen_session` `feedback` first; then
    `rhen_session` `continue` with `minutes` set to the figure they want. The plan allows exactly one
    figure, so a different one is refused, and the refusal names that figure: repeat the same `continue` with it.
    If it says the session cannot be continued, make the `finish` call instead.
- A sleep running is ended with `rhen_activity` `finish`, never a session finish. An action session
  ends with `rhen_session` `finish`, never `rhen_activity`.
- A session over a deliverable credits the step they are on. If no step is current the time is not credited to one.

## Check-ins (`rhen_check_in`)

When `rhen_status` carries a pending check-in, ask them in plain words and record the answer.
`status` is `on-track`, `deviated` or `unknown`. `on-track` ends any open deviation. `deviated` requires a
`category`, exactly one of `work`, `family`, `life_admin` or `other`, and may carry a `note` and a `target` (the
id of the action actually worked on; nothing is started). `category`, `note` and `target` are refused on the
other two. Ask which category fits; do not guess their answer.

## "Doing something else"

A deviated answer stays on plan only if you then call `rhen_disrupt` with all five: `doing` (or `target` as
`action|deliverable|commitment|project:<id>`), `until` (an ISO time or `+90m`), `location` (a saved place's id or
name), `contexts` (ids or names, comma-separated, at least one) and `exclusive` (`true` if it takes all of them,
`false` if they could still do other things). Ask them for any you do not know. Get the place and context ids by
calling `rhen_disrupt` with no options. A deviation with no disruption lapses at once and needs
`rhen_reenter`. `rhen_disrupt` with `end` ends it early, a new on-track check-in also ends it, and
undo reverses it. With no options it only reads what is in force and the place and context ids.

For an unplanned thing that already happened or is happening (a call, car trouble, lunch) use
`rhen_disruption` `start`; never invent routine steps for it. It is the older schedule-disruption tool,
not `rhen_disrupt`. Its `source` is exactly one of `work`, `family`, `life_admin` or `other` (default
`other`); a visitor is `family` or `other`, whichever fits, so ask if unsure. `duration` is a preset name or minutes.

`rhen_activity` `start` needs `type`, `target` and `minutes` (a whole number of planned minutes; it is
refused without them). For a `fixed_commitment` also pass `phase`: `setup`, `travel`, `arrival`, `active`,
`transition` or `return`, the one the plan is in now. It starts only the commitment the plan is tracking right
now (assert arrival first if it is at a place); a future commitment cannot be started. A `finish` outcome is
`completed`, `stopped`, `blocked`, `did_not_start` or `skipped`, not the session outcomes.

## Arrivals and trips

- Arrived somewhere: `rhen_arrive` with `place`, a saved place's id or exact name. List them with
  `rhen_list` entity `conditions`; if none fits, ask rather than pick the nearest. A place-less arrival marks its prep steps done.
- A trip or block of days: `rhen_span`. A repeating thing done outside the app: `rhen_cadence`
  `complete`.

## After any of these

Re-read `rhen_status` and tell them what the directive is now, in a sentence.
