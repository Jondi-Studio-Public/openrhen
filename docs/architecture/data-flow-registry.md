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
- **Freshness:** `fresh`, `late`, `stale`, `never`, `failing`, `n/a` or `probe_unresolved`. A threshold is the entry's own, then the connection's cadence, then learned from 30 days of hourly arrivals (warn at 1.5 x and error at 3 x the p95 gap, clamped to 2 h to 14 d, at least 20 buckets), then the entry's own `coldStart` numbers (set on the entry by its owner; core holds no table keyed by product). A failing attempt shows as `failing` even with no threshold. Imports and manual sources are `n/a` and show their age. Learned thresholds carry the days of arrivals they rest on; the issue tiering that limits a short history to the degrading tier is applied by the checks, not the reader.
- **`probe_unresolved`** means the probe query errored or its token or stamp is gone; the issue's `next` line says what to change. Only connection, timeout and resource errors (SQLSTATE 08, 57, 53) are called transient and told to retry with `rhen doctor`; any other error means the entry or its probe is wrong. **`token_not_bound`** (tidy) means a push source has no `tokenName`, so it is judged by its rows.
- **Devices** (`phone`, `pc` and `wearable`; the `physiology` source is accepted and nothing sends yet) roll up by `device`: last seen is the newest success among their entries, with the entry it came from.

`GET /api/data-flow` (scope `read:plan`, hand-added in `mcp-route-table.ts`) returns `{ generatedAt, build, entries, datasets, devices, edges, unused, health }`; without `DATABASE_URL` it answers 503 and says to set it and call `GET /api/data-flow` again; if the probes fail, `health` is `{ unavailable, reason, next }` with a fixed reason (the real error goes to the server log) and the static graph still comes back. `health.counts.never` is the number of sources not set up. The body carries run-log error text (clipped to 200 characters), so it stays behind `read:plan`; the narrower `read:activity-health` scope is not granted to connectors by default and nothing here changes that. `rhen sources [id] [--problems] [--unused] [--json] [--offline]` prints it. It is a stdio-only MCP tool (`rhen_sources`), so the remote tool list is unchanged, and its output is fenced as untrusted because run-log error text is in it.

## Not yet built

The Data page and the doctor source checks are later changes. See [Writing a connection](writing-a-connection.md) and [Writing an add-on](writing-an-addon.md) for the code a new entry describes.
