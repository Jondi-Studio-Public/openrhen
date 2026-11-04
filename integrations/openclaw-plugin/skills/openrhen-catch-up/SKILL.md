---
name: openrhen-catch-up
description: What to do when the owner has been away and the plan is stale (catchUp.state due) or a call fails with reentry_required: the catch-up interview, settling what happened, and pulse re-entry. Read when status says a catch-up is due or any call is refused for re-entry.
metadata: {"openclaw":{"emoji":"🧭"}}
---

# After a break

## Catch-up

When `rhen_status` says `catchUp.state` is `due`, they have been away and the plan is stale.

1. Read `rhen_catch_up`. It lists occurrences and lapsed deadlines, each with the id and version a verdict names.
2. Ask what actually happened, in a few short grouped questions, not one by one.
3. Settle what they answered with `rhen_catch_up_settle`. Settle only what they told you; leave the rest.
   Give `verdicts-json` as an array of `{"entryId": "<id from the read>", "verdict": "done|ended|skipped|dropped|pending"}`.
   Optional per entry: `at` (when it happened or ended; for `done` and `ended`), `remainingMinutes` (with
   `ended`), `moveTo` (a new date for `pending` on a deadline), `becomes` (`paused` or `done`, for `dropped` on a
   deadline) and `version` (the one the read showed; a mismatch is a conflict for that entry). Bulk instead of a
   list: `bulk` `all_skipped` (optionally `day` as `YYYY-MM-DD`, or `project`), `bulk` `all_dropped` (with
   `project`), or `bulk` `skip_older_than` (with `days`). `all_dropped` and any `dropped` discard work, so use
   them only on the owner's own words. `close-window` closes the window once nothing is left.
4. Write anything new they mention as ordinary records (`openrhen-writing`).
5. Finish with a fresh `rhen_status` and tell them the directive.

Undo reverses a settle. Never mark things done on a guess.

## Re-entry (`reentry_required`)

When a call fails with `reentry_required`, their pulse has lapsed: the plan no longer assumes they are on it, and
every call except re-entry is refused until it is done.

1. Call `rhen_reenter` with no arguments. It shows the tier, the gap, what is missing, the items to review
   and the place and context ids.
2. Ask them where they are, their energy, which contexts they have, and what happened in the window. Never guess.
   Show the choices the read listed instead of asking open questions: location must be a saved place (its id or
   exact name), and contexts are the owner's call. Never pick or "infer" contexts for them unless they explicitly
   delegated that. Offer `keep_open` as the default for a project and wait for the answer.
3. Call it once with everything, as these exact arguments:
   - `location`: a saved place's id or name.
   - `energy`: `high`, `medium`, `low` or `recovery`.
   - `contexts`: ids or names, comma-separated, or `none`.
   - `settlement-json`, an object holding only the forms the gap accepts. Under 2 hours: nothing to settle. 2 to
     36 hours: `items`. 36 hours to 7 days: `items` and `days`. Over 7 days: `items`, `days`, `projects` and
     `startFresh`. Omit it when the read lists nothing to review.
     - `items`: `[{"entryId": "<id from the read>", "verdict": "done|ended|skipped|dropped|pending"}]`, with the
       optional `at`, `remainingMinutes`, `moveTo`, `becomes` and `version` described under Catch-up.
       Only an item can write `done`; a deadline an outside party set needs its own item at every tier above under-2h.
     - `days`: `[{"day": "YYYY-MM-DD", "answer": "nothing_recorded"}]`. It never means done.
     - `projects`: `[{"projectId": "<id>", "answer": "keep_open|drop_all"}]`.
     - `startFresh`: `true`.
   - `note`, `basis` and `evidence` as for any write.
   It is all or nothing; an incomplete answer is refused, naming each gap.
   A refused answer wrote nothing; get the missing answers from the owner and send the corrected call. A timed-out
   call is resent unchanged with its same `command-id`; a corrected answer is a new write with a new one.
4. A bulk answer never means done: mark done only what they confirmed, item by item.

`rhen_undo` reverses it. A longer gap coarsens the catch-up: for a long absence ask about the big
things first rather than every block.

## When re-entry fails

- **Owner only.** Never send `startFresh` or a project `drop_all` unless the owner asked for exactly that, in
  their own words in this conversation. Pass `basis` `stated` with those words as `evidence`. They wipe the plan,
  so never use either as an escape hatch; `startFresh` exists only for a gap over 7 days. Otherwise answer the
  items one by one, or use `keep_open`.
- A `rhen_reenter` conflict that names `Unknown entry id` (for a wake or a check-in; `rhen_catch_up_settle` takes those ids itself): stop and report the error text verbatim.
  Do not retry and do not guess a different settlement.
- A changed answer after a conflict or a re-read is a new write with a new `command-id`; only an identical
  resend after a timeout reuses the id.
- Ask in one grouped message with numbered options and the default marked, then wait. If the owner is not
  reachable, leave it open; do not propose or settle in their place.
- Location, energy and contexts are the owner's alone. If they cannot be reached on a lapsed pulse, stop
  and say so: do not call `rhen_reenter` with guessed or `inferred` answers.
- Report any error text verbatim. Do not theorise about its cause ("stale records") or promise a workaround.

## Tell them what you did

One short message: what you settled, what is still open, and what the directive is now.
