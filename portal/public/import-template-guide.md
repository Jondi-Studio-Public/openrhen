# OpenRhen import template guide

Use UTF-8 CSV. Keep the downloaded header names unchanged. Dates and timestamps use ISO 8601; a timestamp with an offset, for example `2026-08-20T17:00:00+10:00`, is exact, and one without an offset is read as your own timezone's clock. List values use `|`, for example `home|laptop`. Allowed booleans are `true` and `false`.

`import_key` is required in every file. It is a stable, human-readable identifier containing up to 120 characters, such as `study`, `network-assignment`, or `draft-section-1`. Reusing the same entity type and key previews an update; a key the import has not seen before creates the record, and a record left out of a later file altogether is left unchanged. Relationship columns reference these keys, not database IDs.

On an update, a blank cell clears the stored value — a list becomes empty — and a column left out of the file leaves it unchanged, so delete the columns you do not mean to change. A required column may therefore be omitted as a whole on an update, but never left blank.

## areas.csv

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable area key |
| name | yes | Unique area name |
| description | no | Plain text |
| status | yes | active, paused, done, cancelled, archived |
| sort_order | yes | Integer 0 or greater |

## outcomes.csv

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable outcome key |
| area_key | yes | `import_key` from areas.csv or a previously imported area |
| title | yes | Outcome title |
| definition_of_done | yes | Observable completion condition |
| value | yes | Integer 1–5 |
| status | yes | active, paused, done, cancelled, archived |
| deadline_at | no | ISO timestamp |
| review_on | no | ISO date, `YYYY-MM-DD` |

## projects.csv

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable project key |
| outcome_key | yes | Outcome import key |
| title | yes | Project title |
| status | yes | active, paused, done, cancelled, archived |
| uncertainty | yes | known, some, high |
| consequence | yes | Integer 1–5 |
| internal_deadline_at | no | ISO timestamp; not after external deadline |
| external_deadline_at | no | ISO timestamp |
| remaining_effort_override_minutes | no | Integer 0 or greater; leave blank unless intentionally overriding action-derived effort |

## deliverables.csv

Projects may contain actions, deliverable shells, or both. Use an action for ordinary directly executable work; use a deliverable when work must enter Breakdown, Carry out, Review only after the engine schedules it.

This creates shell metadata only. It never creates completion criteria, BCR steps, evidence, reviews, or sessions.

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable deliverable key |
| project_key | yes | Project import key |
| title | yes | Deliverable title |
| details | no | Brief or source context |
| status | yes | needs_breakdown, cancelled, archived |
| uncertainty | yes | known, some, high |
| importance | yes | Integer 1–5 |
| consequence | yes | Integer 1–5 |
| internal_deadline_at | no | ISO timestamp; not after external deadline |
| external_deadline_at | no | ISO timestamp |

## deliverable_dependencies.csv

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable edge key |
| deliverable_key | yes | Blocked deliverable key |
| depends_on_deliverable_key | yes | Prerequisite deliverable key |

Deliverable dependencies must not reference themselves or create a cycle.

## actions.csv

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable action key |
| project_key | yes | Project import key |
| title | yes | Concrete action title |
| status | yes | inbox, planned, active, doing, waiting, blocked, done, cancelled, archived |
| optimistic_minutes | yes | Positive integer |
| expected_minutes | yes | Positive integer, at least optimistic |
| pessimistic_minutes | yes | Positive integer, at least expected |
| remaining_minutes | yes | Integer from 0 through pessimistic |
| energy | yes | high, medium, low, recovery |
| minimum_session_minutes | yes | Positive integer |
| maximum_session_minutes | yes | Integer at least minimum session |
| splittable | yes | true or false |
| setup_minutes | yes | Integer 0 or greater |
| importance | yes | Integer 1–5 |
| consequence | yes | Integer 1–5 |
| repeat_every_days | no | Cadence: suggest it every N days when time allows, ranked by importance; blank = one-off, and 0 turns an existing cadence back into one |
| contexts | no | Pipe-separated values, e.g. `home\|laptop` — one AND pathway; prefer `requirements` for anything with alternatives. Ignored whenever the sheet has a `requirements` column at all. |
| requirements | no | Ways this action can be done: routes separated by `\|`, each an AND of conditions joined by `+`, e.g. `desktop+online \| campus`; blank means unconstrained |
| prefers | no | Pipe-separated conditions that improve ranking but never block eligibility, e.g. `home\|quiet` |
| available_from | no | ISO timestamp |
| deadline_at | no | ISO timestamp; blank means open — offered when there is slack, never overdue |
| latest_start_at | no | ISO timestamp |
| notes | no | Free-text detail — exact steps, source links, or context to remember later |

Effort must satisfy optimistic ≤ expected ≤ pessimistic, remaining must be between 0 and pessimistic, and the minimum session must be positive and no greater than the maximum. Every condition named in `requirements` or `prefers` must exist in conditions.csv or the existing catalogue.

A row with `repeat_every_days` is a cadence rather than a one-off: it is suggested every N days when there is time for it, ranked by how much it matters, and never turned into an appointment. Use it for "run every 3 days" or "practise maths daily" (daily = 1). The series starts the day you commit the import and ends only when you say so. A blank leaves the row an ordinary one-off and, on an update, leaves an existing cadence exactly as it stands — the one exception to the blank-clears rule above, so a sheet written before the column existed cannot quietly end a cadence. A 0 turns an existing cadence back into one-off work. Re-importing the same key changes the interval rather than restarting the cadence.

## dependencies.csv

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable edge key, e.g. `draft-after-research` |
| action_key | yes | Dependent action import key |
| depends_on_action_key | yes | Prerequisite action import key |

Dependencies must not reference themselves or create a cycle.

## entity_prerequisites.csv

Every prerequisite edge that is not action-to-action (`dependencies.csv`) or deliverable-to-deliverable (`deliverable_dependencies.csv`): a project's, or one between different kinds. Put those same-kind edges on their own sheets; here they are refused.

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable edge key |
| entity_kind | yes | project, deliverable, action |
| entity_key | yes | Blocked entity import key |
| requires_kind | yes | project, deliverable, action |
| requires_key | yes | Prerequisite import key |

Entity prerequisites must not reference themselves or create a cycle. Include a row only after both ends exist in the reference or in this import; a row never removes a stored edge.

## fixed_commitments.csv

Each row is one dated occurrence. For an appointment that repeats on a fixed interval use fixed_commitment_recurrences.csv instead.

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable commitment key |
| location_key | no | Key of a saved place; lets the planner work out the journey |
| title | yes | Commitment title |
| starts_at | yes | ISO timestamp |
| ends_at | yes | ISO timestamp after starts_at |
| status | yes | confirmed, tentative, cancelled |
| location | no | Plain text |
| setup_before_minutes | yes | Integer 0 or greater |
| transition_after_minutes | yes | Integer 0 or greater |

## fixed_commitment_recurrences.csv

Use this instead of fixed_commitments.csv for an appointment that repeats on a fixed interval (e.g. "every 2 weeks on Friday"). Committing a row creates a recurring rule; the plan automatically generates individual commitments for the current planning horizon and keeps generating them as the horizon rolls forward. To end a series, re-import the same import_key as a delete row — this stops future commitments without removing ones already in the past.

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable rule key |
| location_key | no | Key of a saved place; lets the planner work out the journey |
| title | yes | Commitment title |
| timezone | yes | IANA timezone, e.g. Europe/London |
| start_date | yes | ISO date (YYYY-MM-DD) of the first occurrence |
| end_date | no | ISO date; leave blank for an open-ended series |
| interval_days | no | Integer > 0; every 2 weeks = 14, weekly = 7; required when interval_unit is days or blank |
| interval_unit | no | days, weeks, months |
| interval_weeks | no | Integer > 0; required when interval_unit is weeks (1 = every week, 2 = every fortnight) |
| weekdays | no | Required when interval_unit is weeks: the days it falls on, e.g. `Tue, Thu`. Must include the weekday of start_date |
| interval_months | no | Integer > 0; required when interval_unit is months |
| month_anchor | no | day_of_month, last_day, nth_weekday, last_weekday |
| local_start_time | yes | HH:MM, 24-hour clock |
| local_end_time | yes | HH:MM after local_start_time |
| location | no | Plain text |
| setup_before_minutes | yes | Integer 0 or greater |
| transition_after_minutes | yes | Integer 0 or greater |

## conditions.csv

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | The condition's own id — a short, stable slug such as `home` or `desktop`, which requirements, prefers and grants reference |
| name | yes | Display name |
| kind | yes | location, capability, contact |
| status | no | active, archived |
| portability | no | fixed, portable |
| grants | no | Location only — a `\|` list of fixed capability/contact import_keys normally available at this location |
| pathways | no | Capability only — routes that make a composite capability available, in the same `+`/`\|` syntax as requirements, e.g. `desktop+online \| laptop+online`; blank means primitive |
| travel_minutes | no | Location only — typical minutes to get here from elsewhere; integer 0 or greater |
| setup_before_minutes | no | Location only — buffers around arriving and settling here; integer 0 or greater |
| transition_after_minutes | no | Location only — buffers around arriving and settling here; integer 0 or greater |
| channels | no | Contact only — a `\|` list from in_person, sync_remote, async |

## plan_links.csv

| Column | Required | Format or allowed values |
|---|---:|---|
| import_key | yes | Stable link key. Plan links are only ever created: a row that names a link you rejected, or an end that does not exist, is refused, and nothing here deletes a link |
| from_type | yes | area, outcome, project, deliverable, action, commitment, contact, place, source, subject |
| from_id | yes | The id of the item it starts at |
| to_type | yes | area, outcome, project, deliverable, action, commitment, contact, place, source, subject |
| to_id | yes | The id of the item it ends at |
| kind | yes | about, counts_toward, prepares, before, occurrence_of, involves, references |
| weight | no | Optional strength from 0 to 1 |
| evidence | no | Optional `\|` list of short notes on why the two items belong together |

## Confirmation rules

Preview never changes planning data. Fix or remove every blocking record, save and validate the draft, then commit. Commit is one PostgreSQL transaction: if any reference, version, constraint, or dependency check fails, no planning record from the batch is written. You may instead commit only the ready rows; the blocked rows are moved into a new draft batch to fix later.
