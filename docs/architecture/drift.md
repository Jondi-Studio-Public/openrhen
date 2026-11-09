# Drift detector

Status: PR 1 implemented; PR 2 pure parts implemented (`drift-rules.ts`, `drift-eval.ts`, no flag writer yet) (the pure episode detector, `GET /api/drift-report`, `rhen drift report`); activity mismatch is held back, see "Held back". Owns: what counts as one drift, how its time and its pinning are decided, and the read route that reports episodes (`platform/contracts/src/drift/`, `portal/server/drift/`).

A drift is a moment the person stopped doing what the plan sanctioned. The detector turns stored rows into **episodes**, one per drift however many signals saw it, so a later measure of "did we see it coming" counts drifts and not signals. It only measures. Nothing under `engine/`, `now-activity.ts`, the planning contracts or `plan-input-tables.json` imports or reads it (`drift-boundary.test.ts`), so a detection never reorders what the plan offers. It sets nothing, sends nothing and has no switch.

## Episodes

| Type | Defined by | Never counted |
|---|---|---|
| `deviated_checkin` | a check-in answered `deviated` by the person, outside any running session | silence (an unanswered check-in), `disrupted`, `alternative` sessions, answers by an agent, answers with source `session_reconciliation` |
| `unsanctioned_session` | a session that started with no plan sanction | a `planned` session that never started, sessions created before the legacy cut |

- **One episode per drift.** A session that later ends, or switches to another off-plan item, is extra evidence on its start (`session_ended`), not a second event. A deviated answer within 10 minutes before the session starts or after it ends joins that session's episode. The primary type is `unsanctioned_session` when both are present. Counts are of episodes per primary type; per-signal counts sit beside them.
- **Times.** `occurredAt` is when the drift happened. `knownAt` is when the system first knew: `startedRecordedAt` or `endedRecordedAt` when a reconciled session was recorded later than its time, else `occurredAt`.
- **Pinned.** An episode is pinned when `occurredAt` was recorded live: an unsanctioned session whose `knownAt` is within 2 minutes of its start. A deviated check-in is never pinned, because its time is when it was answered. **Only pinned episodes may count toward lead-time recall or the go/no-go count.**
- **Unsanctioned means no sanction at start.** `sessions.plan_sanction` is null when the target was unsanctioned at start, and also on a session older than the column. The judge's `unsanctioned` reason is not stored (pulse segments keep `lapsed`, not the judge's reason), so the detector reads the column. `legacyBefore` (`?legacyBefore=` on the route, `--legacy-before` on the CLI) skips sessions created before that time; without it every null counts, which overcounts on a database that holds old rows. Sessions an agent started with a null sanction count as the person's drift too (`started_by` is not read yet). When a table hits its row cap the newest rows are kept and the oldest dropped.
- **Deviated check-ins** are skipped inside a running session, where the evidence is the session itself.

## The read route

`GET /api/drift-report` (scope `read:plan`, hand-added in `mcp-route-table.ts`, entry `rest-drift-report` in the data-flow registry as a pass-through read) returns `{ generatedAt, window, legacyBefore, truncated, counts, episodes }`. It reads `check_in` and `sessions` only, never the activity store, and is bounded two ways: by time (`?days=`, default 30, at most 90, or `?from=` and `?to=` for a window of at most 90 days; rows are widened by the 10-minute collapse window only) and by rows (5,000 per table; `truncated` says a table hit it). Without `DATABASE_URL` it answers 503 and names the next call; an unreadable time or a window over 90 days answers 400.

`rhen drift report [--days n] [--from iso] [--to iso] [--legacy-before iso] [--json]` prints it. The command is `ownerOnly`, so it is not an MCP tool and the tool count is unchanged (`tools/cli/test/mcp.test.ts` pins it). The module is imported through `@openrhen/contracts/drift` and deliberately not re-exported from the contracts barrel.

## Held back: activity mismatch

The plan's third type, foreground activity that does not fit the planned item, needs to know whether the planned item is "work". No field says so: `actions`, `commitments`, `projects` and `outcomes` carry no work or leisure class, `areas` has only a free-text `name`, and `deviation_category` classifies what the person did instead. Reading a name such as "Work" would be a guess, so the type is not built and is recorded as an escalation. When an owner-editable field exists, the type returns with its category table (`games` and `game` folded, unmapped meaning unknown, never a mismatch), and with rules that idle, lock, display-off, pause and capture gaps break an interval and never count, that liveness comes from `heartbeat` and `coverage` rows, and that applied corrections (`attrs.corrects`) are honoured first.

## Shadow rules and the evaluation (PR 2, pure parts)

`drift-rules.ts` holds two baseline rules, run in shadow (a flag sends nothing). Rule B flags the first 30 minutes after a shift end that the caller measured from activity (not pulse's shift-grace lapse). Rule A, a hidden denylist interval or a game/media foreground during a work item, is a pure function over an injected `isWorkItem` predicate; with none wired it never fires, because no field marks a work item yet. Thresholds live in one frozen object. A moment is eligible when pulse is `on`, capture is live, and it is at least 5 minutes after a switch; each rule has a 15-minute cooldown and a 5-minute flag bucket for the idempotent key `user|rule|bucket`.

A rule is scored only on drift types whose definition shares none of its signals (`labelSignals`, `ruleSignals`; rule A is never scored on activity mismatch). Features may not touch pulse-state internals; `drift-features.test.ts` walks the import graph to prove it.

`drift-eval.ts` scores flags: a hit is a pinned episode of a scorable type starting 2 to 5 minutes after the flag; a false alarm is a flag with none; rates are per waking day (capture-off days reported apart). Intervals come from a day-resampled bootstrap with a fixed seed and a fixed threshold; below 30 scorable pinned drifts in the scored subset the result is "not testable". The report prints the drifts lost to the 5-minute post-switch window, compares with random flags at the same alarm budget, and records the 20% holdout hash assignment without using it to subset. A chronological split with a one-horizon embargo is available for threshold tuning.

Not built: the flag writer (an activity-store source `drift`, kind `flag`), its registry entries and probe, and the report route.
