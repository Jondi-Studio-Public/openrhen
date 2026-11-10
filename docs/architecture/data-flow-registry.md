# Data-flow registry

Status: implemented for the registry, the full set of core entries and the coverage rules; the health reader, `GET /api/data-flow` and `rhen sources` are in; the Data page follows. Owns: the typed registry of every data entry point (`platform/contracts/src/data-flow/`), the checks that hold it to the code (`portal/server/data-flow/`), and the seam an extension uses to add its own entries.

Every collector, shared pipe, reader and sink is one entry, so "where does this data come from, where does it go, and what does it give" has one answer that CI keeps true. Tables come from the schema; activity data is split per source and kind (`pg:activity_events[source=<source>,kind=<kind>]`).

## An entry

An entry has a `role` (`source`, `pipe`, `reader` or `sink`), the datasets it reads (`from`) and writes (`to`), the code it lives in (`code.paths`, `routes`, `loops`, `mcpTools`) and one health probe. Dataset names borrow OpenLineage: `namespace:name`, such as `pg:commitments` or `surface:page/review`. A source that posts through a shared path names it in `via` (`activity-ingest`); its own `to` then becomes the partition of its activity source. Free text is capped (name 60 characters, `gives` and `value.note` 80, the rest 120) so the registry stays short.

What a source gives is computed, not written: the graph walks from its output datasets through the readers that consume them to a value surface (an engine, a page, an MCP tool, a device route, push, or outward publishing). A reader's `gives` line says what it provides. Backup and the raw REST read are pass-through and never count. A source that reaches nothing shows as "collected, gives nothing yet"; one that is accepted but that nothing posts (`noProducer`) shows as "accepted, nothing sends".

The plan-input table list is `platform/contracts/src/data-flow/plan-input-tables.json`. `scripts/repository/write-path-registry.mjs` imports it for the one-write-path guard, and the registry's engine reader is built from it minus the tables it lists as `notRead`.

## Adding an entry

- Add it beside the code, in the matching file under `platform/contracts/src/data-flow/entries/`, in the same change as the collector or reader.
- An extension adds its own entries without putting private names in core: set `dataFlow` on its `ContractsExtension` (a function returning `entries`, `datasets`, `amend` and `composedBuild`). Use a distinct extension id of the form `data-flow-<name>`. `amend` overrides core entries by id (cadence, device, credentials, extra external code) and must name an id that exists.
- Keep generic systems and code facts in core. Anything that names a person's providers, devices or accounts belongs in the extension.

## What CI checks

`portal/server/data-flow/registry-coverage.test.ts` runs the checks in `registry-checks.ts` against the real repository:

- **S1 to S4:** every path, route (exact `METHOD /url`, no wildcards), loop, connection, activity source, sync provider, MCP tool, `via` and `feeds` reference exists. A directory path is allowed only as `integrations/<name>/src/<sub>/`.
- **S5, S7:** every `pg:` dataset is a schema table, a partition names a registered source and a kind that source takes, and every probe table, column and `where` key exists.
- **S6, S8:** an extension's `amend` keys are core ids; a `surface:page/<path>` has its `page.tsx`, a `surface:tool/<name>` is in the MCP manifest.
- **X1, X2:** ids are unique and kebab-case, a reader with no probe gives a reason, and every free-text field is within its cap.
- **E1:** the engine reader reads exactly the plan-input list minus its `notRead`, and no table the engine is blind to is a plan input.

**Coverage** (core-owned entry points only; overlay files in `.sync-core.json`, `private/` seams and extension registrations are exempt until the extension's own entries cover them):

- **A1, P1, C1:** every activity source, every parser and extractor file, and every connection is in some entry.
- **L1, L2, R1, R2, M1:** every worker and service loop, every write route, every GET route that writes, and every write tool is in an entry's `code`, or is on a short infrastructure list with a reason (sign-in, tokens, probes).
- **T1, D1:** every table is on an entry's `from` or `to`, or noted as infrastructure or dead; every device has a probe.
- **V1, V1-reverse, V2, V3:** each entry's `to` is a table its closure writes, a table its closure writes is in `to` or `incidentalWrites`, a partition appears in the code, and a reader's page, tool or device surface is backed by its code.
- Removing any entry fails one of these, and the 2.5 acceptance list (which sources are collected but unused, which are accepted with nothing sending) is pinned against the core-only registry.

The closure walker (`enumerate.ts`) follows relative imports, the portal's `@/` alias and `@openrhen/*` imports, and resolves a named import through re-export barrels to the module that defines it. It stops at shared pipe modules, infrastructure modules (the database client, secrets and logging) and every `private/index.ts` seam. Its depth is capped at 6.

`portal/server/watch-history/engine-blind.test.ts` keeps the registry out of planning: the `data-flow/` folder may import only zod and a short list of contracts modules, and no planning code may import it.

## Live health

`portal/server/data-flow/health-reader.ts` reads one signal per entry from tables that already exist (no migration, no writes; a read-only database connection can run it). Probes are batched by kind, including those nested under a `lag`, and cached for 60 seconds per database handle and probe set; concurrent reads share one query round and a transient failure is not cached.

- **Probe kinds:** `sync-runs` (latest run per provider, `summaryMatch` to split stages, `needs_review` counts as success), `sync-status`, `activity` (newest row, 24 h and 7 d counts, kinds seen, and the `import:` and `ingest:` run rows), `extractor`, `telemetry` (real calls only), `max`, `last-used`, `json-stamp` and `lag`.
- **Freshness:** `fresh`, `late`, `stale`, `never`, `failing`, `n/a` or `probe_unresolved`. A source that reports coverage is judged by how far it has been read and by its own rhythm (`rhythm.ts`): the owner's `expectedEveryMinutes` (T = 3N, `from` is `owner`), then its learned limit once real (`learned`: T is the larger of 3 x the median gap and 1.5 x the second-largest gap between its live coverage posts, at least 5 minutes, with 6 gaps and a history of at least max(24 h, 4T)), held to 4 x the collector's declared limit when one exists, then the collector's declared cadence (`collector`). From 2 gaps up to those minimums the limit is `provisional` and never blocks; with fewer than 2 gaps and nothing declared there is no threshold, `noRhythm` says so and nothing is late. Late is at T and stale at 2T. An entry may set `changesPlan` so a stale one blocks; an entry that is only of the message family counts as changing the plan once its collector reports coverage. Gaps and age both use the coverage row's `ts_end`, and rows from an import or posted more than a day after their `end` are not posts. Otherwise a threshold is the entry's own, then the connection's cadence, then, for a source that does not report coverage, learned from 30 days of hourly arrivals (warn at 1.5 x and error at 3 x the p95 gap, clamped to 2 h to 14 d, at least 20 buckets), then the entry's own `coldStart` numbers (set on the entry by its owner; core holds no table keyed by product). A failing attempt shows as `failing` even with no threshold. Imports and manual sources are `n/a` and show their age. Learned thresholds carry the days of arrivals they rest on; the issue tiering that limits a short history to the degrading tier is applied by the checks, not the reader.
- **`probe_unresolved`** means the probe query errored or its token or stamp is gone; the issue's `next` line says what to change. Only connection, timeout and resource errors (SQLSTATE 08, 57, 53) are called transient and told to retry with `rhen doctor`; any other error means the entry or its probe is wrong. **`token_not_bound`** (tidy) means a push source has no `tokenName`, so it is judged by its rows.
- **Devices** (`phone`, `pc` and `wearable`; the `physiology` source is accepted and nothing sends yet) roll up by `device`: last seen is the newest success among their entries, with the entry it came from.
- **Per-kind lateness:** for a push source with a learned rhythm, each kind is also learned on its own (20 hourly buckets over 30 days). A kind whose newest row is past its own warning while the source as a whole is fresh appears as `lateKinds` on the node (the node stays `fresh`; doctor names the kind).
- **`credentialPresent`:** true when the source's bound agent token exists and is live, used or not, so a `never` source with a token reads as silence rather than a source never set up.
- **Time limit:** the probes run on one reserved connection with a `statement_timeout` of 8 s (cleared before the connection returns to the pool). A probe that hits it shows as `probe_unresolved` with a retry step instead of holding the whole answer.

`GET /api/data-flow` (scope `read:plan`, hand-added in `mcp-route-table.ts`) returns `{ generatedAt, build, entries, datasets, devices, edges, unused, health }`; without `DATABASE_URL` it answers 503 and says to set it and call `GET /api/data-flow` again; if the probes fail, `health` is `{ unavailable, reason, next }` with a fixed reason (the real error goes to the server log) and the static graph still comes back. `health.counts.never` is the number of sources not set up. The body carries run-log error text (clipped to 200 characters), so it stays behind `read:plan`; the narrower `read:activity-health` scope is not granted to connectors by default and nothing here changes that. `rhen sources [id] [--problems] [--unused] [--json] [--offline]` prints it. It is a stdio-only MCP tool (`rhen_sources`), so the remote tool list is unchanged, and its output is fenced as untrusted because run-log error text is in it.

## The Data page

`/data` (`portal/features/data-flow/`, linked from the You and Connections pages) is the picture of this graph. It only reads, and adds no dependency: the map is SVG. The counts line ("4 late · 1 device silent · 11 collected, unused · 5 accepted, nothing sends") links to it.

- **Model** (`data-flow-model.ts`): reshapes the API body into five columns (outside systems and devices, collectors, stores, readers, what it gives) and edges. Tables read and written by the same entries draw as one store, infrastructure tables as one "Machinery tables" store, the activity store opens into one row per source, `local:` files are one node, and an edge from a surface is not drawn. Idle sources (never set up, no rows, no issue) fold into one "N more not set up" node per category. A value surface takes its label and detail from the `gives` lines of the readers that point at it, with a plain kind label as the fallback, never a registry id. Which nodes reach `surface:engine` is computed, and gives solid edges (dotted where the engine is blind).
- **Status:** a dot plus the status and age in words, so colour is never the only signal: green fresh, amber late or unused, red stale, failing or a check that cannot run, grey not tracked or not set up, hollow never heard from, dashed planned (own lane). Backup and raw REST are greyed as pass-through.
- **Filters:** category, Reaches the engine, Problems only, Show planned, Collected, unused, and Core or Private when a build adds its own entries. A filter, or opening a fold, shows every entry; the list view (under 720 px, problems first, a `from → via → to → reaches` strip per row) always does. A filter whose chip has gone is dropped.
- **Panel:** id, method, build and owner; what it gives (one line per surface reached); the tables it reads and writes; live kinds against registered; trigger, thresholds and credential names (never values); last success, attempt and error (the error is plain text in a fence, since it comes from outside); the code behind it; the doctor fix.
- **Layout** (`data-flow-layout.ts`): pure and deterministic. Fixed columns, barycentre sweeps repeated while they help, an adjacent-swap pass, cubic edges. Tests bound the crossings on the real registry and on a 200-node fixture; a registry addition can move the real number, so re-measure rather than widen the slack. Between 720 px and about 1,100 px plus the sidebar the map scrolls inside its own frame.
- **Polling** (`use-data-flow.ts`): every 60 s while the tab is visible, at once on return if the last read is stale; a read is abandoned after 15 s. If a read fails the last graph stays under "Health unavailable", without colours or ages, until a read works.
- **Deferred (needs a health extension):** 30-day bars and the last ten runs, a per-credential ready flag, and a link to issues labelled `data-source:<id>`.

## Doctor source checks

`platform/contracts/src/planning/doctor-sources.ts` is pure; `portal/server/data-flow/doctor-sources-reader.ts` builds its slice from the health reader and the registry's graph, and `readDoctorReport` adds the items beside the existing ones. Calendar and other sync-provider sources keep `sync_late` and `sync_failing` untouched (`keepsSyncChecks`); doctor still writes nothing.

| Check | Raised when | Tier |
|---|---|---|
| `source_late` | a non-calendar source is past its warning, or one kind of it is (`lateKinds`) | degrading; blocking only when past its error threshold, the engine reads it and the threshold is stated (a learned one counts once the source has a month of history: the reader learns the rhythm from the last 30 days and measures the history over 45, so a source gone quiet can still show 30 days) |
| `source_silent` | `never`, and the source's own token exists | degrading |
| `device_silent` | a device with at least two configured feeds has every one of them past its warning; its per-feed items fold into this one (it is blocking if any folded feed's own item would have been), and `location_ping_silent` folds in when the phone's ping feed is one of them | degrading |
| `probe_unresolved` | the probe query errors, a bound token name matches no live token, or a stamp path is gone | degrading; fix `agent` with a `next` step, except a missing token, which is the person's (`rhen agent-token list`, then `create`) |
| `token_not_bound` | a push source has rows and no `tokenName`; only raised when an extension is registered that could bind one | tidy, fix `agent` |
| `sources_collecting_unused` | one summary of rows that arrived this week into a continuous source whose reach is empty; file imports never count | tidy |
| `import_needs_review` | the newest `import:<source>` run in the last 30 days finished `needs_review` ("Archive import skipped 212 rows") | tidy |

If the probes cannot be read, doctor lists the source checks under `notChecked` and answers the rest, with a fixed reason (the real error goes to the server log). Doctor shares the health reader's 60 s cache with `/api/data-flow`, so a fix can take up to a minute to show. The report also carries `sources` (late, device silent, collected-unused and accepted-nothing-sends counts, and the one-line `line`), which the Data check and Connections headers show with a link to `/data`. `DoctorFix.next` holds the exact next step in words for an agent fix. Each check also has a fixed `attention.ts` template.

Known limits:

- A kind that has been quiet for longer than the larger of twice its own warning and 7 days counts as retired on purpose and is not raised, so a kind that stops for good stays visible for at least a week and then disappears.
- `import_needs_review` stays for 30 days after the run. Importing the same file again usually skips the same rows and raises it again; there is no dedupe of repeat runs with an unchanged skipped count.
- The probes run one after another on one connection, on a read-only session, each limited to 8 s and all to 15 s together. Probes not yet run when the 15 s pass are shown as unresolved with a retry step.
- The header's late count is the number of `source_late` items: sync-provider sources and feeds folded into a silent device have their own items and are not counted.

## See also

See [Writing a connection](writing-a-connection.md) and [Writing an add-on](writing-an-addon.md) for the code a new entry describes.
