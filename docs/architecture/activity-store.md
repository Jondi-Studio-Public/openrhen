# Activity store

Status: implemented (ingest, store and owner routes); importers and live pollers are later changes. Owns: the append-only `activity_events` table, its ingest and read routes, the source registry, the content gate, retention and undo. The capture side is [Desktop activity agent](desktop-activity-agent.md). The published request schema is `platform/contracts/activity-events-schema.v1.json`.

Every non-plan data source (the desktop agent, browser history, plays, messages, sleep, weather, phone shortcuts) lands as rows in one table, so a later predictor reads one place. Nothing in the engine, scheduler or pulse reads these tables: a write queues no recalculation, and `portal/server/watch-history/engine-blind.test.ts` fails if any other source file names them. There are no MCP tools for it (the tool list is capped).

## Tables (migration 0147)

- `activity_events`: `id`, `user_id`, `source`, `kind`, `event_key` (idempotency, unique with user and source), `device`, `ts_start`, `ts_end` (null for an instant), `tz_offset_min` (minutes east of UTC at the event, null when unknown), `approximate`, `attrs` (jsonb, at most 8 KB), `content` (text, at most 64 KB, only when the source's gate is on), `import_id`, `ingested_via` (the posting agent's name), `ingested_at`. A trigger refuses every `UPDATE`. `DELETE` and `TRUNCATE` stay possible: restore and the test harness truncate every backup table. Store code deletes only for undo-import, purge-by-source and the retention purge. A wrong interval is corrected by a new row of kind `correction` whose `attrs.corrects` names the event key; raw rows are never rewritten.
- `activity_imports`: one row per file loaded in bulk (`source`, `filename`, `sha256`, `event_count`), unique per user and `sha256`, so concurrent first batches of one file resolve to a single row.
- `activity_source_state`: per source, `content_enabled` (default false), `retention_days` (null keeps permanently), and a `cursor` for later pollers. An absent row means the defaults.

`source` and `kind` are checked in code against the registry (`ACTIVITY_SOURCES` in `platform/contracts/src/activity-events.ts`), not by a database constraint, so a new source needs no migration. Each source has a `schemaVersion`; `correction` is accepted as a kind for every source.

## Ingest

`POST /api/activity-events`, scope `write:activity-event` (preset `activity-capture`, which grants nothing else). Send the token in the `X-OpenRhen-Token` header. Create the token from the agent-tokens card in the portal, or with `rhen agent-token create --name <agent> --scopes activity-capture`.

A batch is `{"schema": 1, "device": "...", "events": [{"id", "source", "kind", "start", "end"?, "attrs"?, "content"?, "tzOffsetMin"?, "approximate"?}]}`, up to 1000 events and 2 MB. Times are RFC 3339, second or millisecond precision. An offset (`+11:00`) is accepted, normalised to UTC, and recorded as `tz_offset_min`; a `Z` time leaves it unknown, and an explicit `tzOffsetMin` wins.

**Single-event shorthand.** A body with no `schema` and no `events` but a `source` is one event: `{"source", "kind", "start", "id"?, "device"?, "end"?, "attrs"?, "content"?}`. When `id` is given it is the event key; otherwise the server derives it from a hash of source, kind, start (to the second), device and attrs, so a shortcut that fires twice for the same second stores once.

The response is `{message, schema, added, alreadyHeld, contentDropped, rejected: [{index, reason}], importId, ingestedVia}`. `message` is one plain-English line, because a phone shortcut shows the body as it is.

- A bad event rejects itself, not the batch; its reason names the exact fix (the known sources or kinds, the limit, the field). A rejected shorthand event answers 400 with that reason as `error`.
- A key already held (in the store, or earlier in the same batch) is `alreadyHeld`: never an error, never a change.
- Content is dropped, and counted in `contentDropped`, when the source's gate is off.
- Whole-request errors: malformed JSON, a wrong `schema`, an empty or oversized list (400), a body over 2 MB (413), a failed token.

**Imports.** The first batch of a file carries `"import": {"sha256", "filename"}`; the response returns `importId`, and later batches carry `"importId"`. `GET /api/activity-imports?sha256=<hex>` answers `{held, importId?, eventCount?}` so an importer can skip a file already held; it takes the capture scope `write:activity-event`. With no `sha256` it lists recent imports.

## Reading back

`GET /api/activity-events?source=&kind=&from=&to=&limit=&after=` returns `{events, next}` in time order (start, then id), `to` exclusive, up to 1000 per page. Pass `next` as `after` for the following page. The owner session may always read; a token needs `read:activity-event`. **That scope exposes `content` (message text, titles, search text) over a token**, so grant it only to an agent you would trust with that text. The `activity-capture` preset does not include it.

## Owner routes

Owner session only, never a token: `GET /api/activity-events/summary` (counts, last event and settings per source, recent imports), `PUT /api/activity-sources/:source` (`{contentEnabled?, retentionDays?}`), `DELETE /api/activity-imports/:id` (undo an import: its events and its record), `DELETE /api/activity-sources/:source/events` (purge a source, including its import records; not undoable).

The content gate decides whether text is stored from then on; turning it off deletes nothing already stored (use the purge for that). It is a consent gate, not a feature switch.

## Retention

`purgeExpiredActivity` (in `portal/server/persistence/postgres/activity-store.ts`) deletes, per source with `retention_days` set, rows whose `COALESCE(ts_end, ts_start)` is older than the cutoff, in batches of 5000. Sources with no setting are kept permanently. Nothing schedules it yet: the worker tick that runs it daily is a later change.

## Backups

All three tables are in the JSON backup (format 22). That backup is one JSON document with one checksum, built in memory. Measured with synthetic rows (a desktop-agent row with a small `attrs`): 1 million rows made a 453 MB file and about 2.4 GB of process memory; 2 million failed with `RangeError: Invalid string length` (V8's string limit), which fails the whole backup, not only this table. A device agent posting every nine seconds reaches about a million rows in under four months, so the activity tables need a streamed backup section before they grow that large.
