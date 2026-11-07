# Activity store

Status: implemented (ingest, store and owner routes); the importers are in `integrations/activity-importers` and [Importing your data](../operations/importing-your-data.md); live pollers are a later change. Owns: the append-only `activity_events` table, its ingest and read routes, the source registry, the content gate, retention and undo. The capture side is [Desktop activity agent](desktop-activity-agent.md). The published request schema is `platform/contracts/activity-events-schema.v1.json`.

Every non-plan data source (the desktop agent, browser history, plays, messages, sleep, weather, phone shortcuts) lands as rows in one table, so a later predictor reads one place. Nothing in the engine, scheduler or pulse reads these tables: a write queues no recalculation, and `portal/server/watch-history/engine-blind.test.ts` fails if any other source file names them. There are no MCP tools for it (the tool list is capped).

## Tables (migration 0148)

- `activity_events`: `id`, `user_id`, `source`, `kind`, `event_key` (idempotency, unique with user and source), `device`, `ts_start`, `ts_end` (null for an instant), `tz_offset_min` (minutes east of UTC at the event, null when unknown), `approximate`, `attrs` (jsonb, at most 8 KB), `content` (text, at most 64 KB, only when the source's gate is on), `import_id`, `ingested_via` (the posting agent's name), `ingested_at`. A trigger refuses every `UPDATE`. `DELETE` and `TRUNCATE` stay possible: restore and the test harness truncate every backup table. Store code deletes only for undo-import, purge-by-source and the retention purge. A wrong interval is corrected by a new row of kind `correction` whose `attrs.corrects` names the event key; raw rows are never rewritten.
- `activity_imports`: one row per file loaded in bulk (`source`, `filename`, `sha256`, `event_count`), unique per user and `sha256`, so concurrent first batches of one file resolve to a single row.
- `activity_source_state`: per source, `content_enabled` (default false), `retention_days` (null keeps permanently), and a `cursor` for later pollers. An absent row means the defaults: the gate takes `OPENRHEN_ACTIVITY_CONTENT_DEFAULT` (off unless set to `on`), retention is permanent.

`source` and `kind` are checked in code against the registry (`ACTIVITY_SOURCES` in `platform/contracts/src/activity-events.ts`), not by a database constraint, so a new source needs no migration. Each source has a `schemaVersion`; `correction` is accepted as a kind for every source.

## Ingest

`POST /api/activity-events`, scope `write:activity-event` (preset `activity-capture`, which grants nothing else). Send the token in the `X-OpenRhen-Token` header. Create the token from the agent-tokens card in the portal, or with `rhen agent-token create --name <agent> --scopes activity-capture`.

A batch is `{"schema": 1, "device": "...", "events": [{"id", "source", "kind", "start", "end"?, "attrs"?, "content"?, "tzOffsetMin"?, "approximate"?}]}`, up to 1000 events and 2 MB. Times are RFC 3339, second or millisecond precision. An offset (`+11:00`) is accepted, normalised to UTC, and recorded as `tz_offset_min`; a `Z` time leaves it unknown, and an explicit `tzOffsetMin` wins. `+00:00` is an offset like any other and gives 0 (an importer whose source cannot tell local time, such as Discord, sends `Z` or leaves it out). An offset must lie within -14:00 to +14:00, the date must exist, the year must be 1970 to 2200, and `id`, `device`, `content` and `attrs` may not hold a NUL or a lone surrogate (Postgres refuses them): such an event is rejected alone, with a plain reason, never as a server error.

**Single-event shorthand.** A body with no `schema` and no `events` but a `source` is one event: `{"source", "kind", "start", "id"?, "device"?, "end"?, "attrs"?, "content"?}`. When `id` is given it is the event key; otherwise the server derives it from a hash of source, kind, start (to the second), device and attrs, so a shortcut that fires twice for the same second stores once.

The response is `{message, schema, added, alreadyHeld, contentDropped, rejected: [{index, reason}], importId, ingestedVia}`. `message` is one plain-English line, because a phone shortcut shows the body as it is.

- A bad event rejects itself, not the batch; its reason names the exact fix (the known sources or kinds, the limit, the field). A rejected shorthand event answers 400 with that reason as `error`.
- A key already held (in the store, or earlier in the same batch) is `alreadyHeld`: never an error, never a change.
- Content is dropped, and counted in `contentDropped`, when the source's gate is off, except in a file import (a batch that carries `import` or `importId`): importing your own file is the consent, so its text is kept whatever the gate says. The gate governs continuous collectors (rhen-watch, phone shortcuts, pollers); a collector must not send `import` to get around a gate that is off. A source with no saved setting takes the server default, `OPENRHEN_ACTIVITY_CONTENT_DEFAULT` (`on` or `off`, default `off`); a saved setting wins both ways.
- While the pulse is lapsed a token is held with a 428 on every route except `POST /api/activity-events` and `GET /api/activity-imports`: a passive recorder (rhen-watch, a phone shortcut with no retry) posts exactly while the owner is away, and the post stores events but returns none. Reading events back stays held.
- Whole-request errors: malformed JSON, a wrong `schema`, an empty or oversized list (400), a body over 2 MB (413), a failed token.

**Imports.** The first batch of a file carries `"import": {"sha256", "filename"}`; the response returns `importId`, and later batches carry `"importId"`. `GET /api/activity-imports?sha256=<hex>` answers `{held, importId?, eventCount?}` so an importer can skip a file already held; it takes the capture scope `write:activity-event`. With no `sha256` it lists recent imports (file names and counts). **An import is one source:** every event in its batches must have the import's source (`import.source`, else the first valid event's), and any other is rejected, so undoing an import or purging a source can never reach another source's events. If every event in a first batch is rejected, send `import.source` explicitly.

## Reading back

`GET /api/activity-events?source=&kind=&from=&to=&limit=&after=` returns `{events, next}` in time order (start, then id), `to` exclusive, up to 1000 per page. Pass `next` as `after` for the following page. The owner session may always read; a token needs `read:activity-event`. **That scope exposes `content` (message text, titles, search text) over a token**, so grant it only to an agent you would trust with that text. The `activity-capture` preset does not include it.

## Owner routes

Owner session only, never a token: `GET /api/activity-events/summary` (counts, last event and settings per source, recent imports), `PUT /api/activity-sources/:source` (`{contentEnabled?, retentionDays?}`), `DELETE /api/activity-imports/:id` (undo an import: its events and its record), `DELETE /api/activity-sources/:source/events` (purge a source, including its import records; not undoable).

The content gate decides whether a continuous collector's text is stored from then on (a file import always keeps its text); turning it off deletes nothing already stored (use the purge for that). It is a consent gate, not a feature switch.

## Retention

**The automatic purge does not run yet.** `PUT /api/activity-sources/:source {retentionDays}` saves the setting, and the response and the summary say so (`retentionRuns: false`, `retentionPurge: "not_running"`): nothing is deleted automatically. To delete now, use `DELETE /api/activity-sources/:source/events`.

`purgeExpiredActivity` (in `portal/server/persistence/postgres/activity-store.ts`) is written and tested. For each source with `retention_days` set it deletes rows whose `COALESCE(ts_end, ts_start)` (and `ts_start`, so the index bounds the scan) is older than the cutoff, in batches of 5000; sources with no setting are kept permanently. It leaves import records, so a retention-purged file still counts as held. The worker tick that will call it daily is a later change.

## Backups

All three tables are in the backup (format 23, after the offer log at 21 and the first activity format at 22). The JSON backup is one document with one checksum, built in memory, and that cannot hold the events at scale: measured with synthetic rows (a desktop-agent row with a small `attrs`), 1 million rows made a 453 MB file and about 2.4 GB of process memory, and 2 million failed with `RangeError: Invalid string length` (V8's string limit).

So `activity_events` is a **streamed section**: its rows are written to `<backup name>.activity-events.ndjson` beside the JSON, one row per line in `id` order, straight from a Postgres cursor inside the same repeatable-read snapshot as the rest of the backup (`backup-format.ts` `readAllTables`, `streamed-sections.ts`). The JSON holds the import records and per-source settings as before, an empty `tables.activity_events`, and a `streamed.activity_events` entry with the file name, row count, byte size and SHA-256. `db:restore:verify` checks the section before touching a database, then inserts it in batches after `users` and `activity_imports`, and reads the restored table back to compare its row count and SHA-256. Measured at 300,000 and 2,000,000 rows, writing and restoring each stays within a fixed memory bound that does not grow with the row count (`activity-backup-scale.integration.test.ts`). The pg_dump taken before a migration holds the events as well.
