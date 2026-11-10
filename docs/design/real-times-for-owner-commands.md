# Real times for owner-device commands

> Status: Built, 2026-11-10
> Owns: the `occurredAt` field on check-in answers and on session and activity commands, and what the server does with it.

An installed app on the owner's phone queues commands while it is offline and sends them when it can. A day lived offline must keep its true times, and the pulse and the predictor read them. So a command may say when the owner really did it. The agent contract is untouched: an agent still uses `startedAt` (24 hours back, 5 minutes ahead) and `endedAt` (not after now).

## The field

`occurredAt` is an optional ISO 8601 instant with an offset. It is accepted only from the owner's own credentials (a signed-in browser or a paired device). An agent that sends it is refused before anything is written, with a message that names the fix (use `startedAt` or `endedAt`, or send the command when it happens). The CLI and the agent tool list do not offer it.

Commands that take it: `start`, `select_alternative`, `correct_start`, `pause`, `resume`, `request_feedback`, `continue`, `finish`, `block`, `did_not_start` (session); `start_activity`, `switch_deliverable_step`, `pause_activity`, `resume_activity`, `finish_activity`, `skip_routine_step`, `reopen_routine_step` (activity); `answer_check_in` (one row). Sleep start and wake, the wake command, catch-up and settle commands, `answer_check_ins` and `voluntary_check_in` do not take it. A sleep start or the end of a sleep session that carries one keeps receipt time and records the claim.

## Rules

1. **Always recorded.** The claimed time is stored on every command that carries it, beside the time the server used: `session_segments.start_occurred_at` / `end_occurred_at`, `check_in.occurred_at`, and the change log row's `evidence.occurredAt` (which also covers commands with no segment, such as a routine step's skip). A note column holds the reason when the claim was not used.
2. **Applied only where consistent.** The claim is used when it is at most 5 minutes ahead of the server clock, no more than 7 days old, and fits what the server holds:
   - a start is after the last recorded wake and after every finished session ended;
   - a command on an open session is strictly after the session's latest recorded boundary (its start and every segment start and end) and before any later session began;
   - a check-in answer is not before the check-in's slot;
   - a finish on a session awaiting feedback does not run past where the work stopped.
   A claim inside the 5 minute grace is held at receipt, so nothing begins or ends in the future.
3. **Otherwise receipt time.** The command applies at receipt, keeps the claimed time and the reason, and is never refused for it. The reply says so in words.
4. **It replaces `startedAt` / `endedAt`** for owner-device calls. Sending both with different instants is refused (same instant in another zone is fine). `correct_start` keeps its required `startedAt`; its `occurredAt` is only recorded.
5. **Maths read it.** The segment boundaries, `started_at` / `ended_at`, the planned end of a start, the remaining time stored at a pause and the planned end set at a resume, a deliverable step switch (and its checkpoint refusal), `last_worked_at` and `completed_at` all read the applied time. `updated_at`, `started_recorded_at`, `ended_recorded_at`, the forecast currency check and the cadence helpers stay on receipt time.
6. **Order is the app's job.** The outbox sends in the order the commands were made, across all entities, through these ordinary commands, so a `finish` still marks the action done and updates remaining time, occurrences and cadence. The server does not reorder.

## The reply

Session, activity and check-in command responses gain `occurredAt` when the command carried one:

```json
{ "claimedAt": "...", "applied": false, "appliedAt": "...", "reason": "...", "message": "Recorded at 4:10 pm, when the server received it, because ..." }
```

A retry with the same `commandId` is answered with the same sentence (read back from the stored evidence).

## Check-ins answered offline

Each queued answer goes through `answer_check_in` with `occurredAt`, one row at a time, while the row is answerable (`pending`, or `unknown` with no answer). `expectedVersion` should be null: a timeout that closed the row meanwhile must not turn the answer into a conflict.

If the row has closed (answered elsewhere, superseded), the answer is not turned into a voluntary check-in, which would count as contact now and could confirm the current item. His words (`deviationNote`) are saved instead as an ordinary pending capture on a `manual_capture` source whose `occurred_at` is the check-in's slot time, with the check-in id and the status he gave in the proposal's fields, and the reply is `{ delivered: false, applied: false, reason: "the check-in closed", message: "Not delivered: the check-in closed ..." }`. An answer with no words saves nothing and says so. The check-in row, its version and the pulse are not touched. A retry saves the words once (the source's external id is the command id).

## Not covered

An agent cannot backdate beyond its own contract. A command refused for a reason other than its time (a wrong version, a closed target) is refused as before and the claim is not recorded, because nothing was written.
