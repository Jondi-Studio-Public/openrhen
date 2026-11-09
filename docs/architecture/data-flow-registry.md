# Data-flow registry

Status: foundation implemented (types, graph, closure walker and the staleness checks, over a few seed entries); the full set of core entries, the coverage rules, the health reader and the Data page follow. Owns: the typed registry of every data entry point (`platform/contracts/src/data-flow/`), the checks that hold it to the code (`portal/server/data-flow/`), and the seam an extension uses to add its own entries.

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

The closure walker (`enumerate.ts`) follows relative imports, the portal's `@/` alias and `@openrhen/*` imports, and resolves a named import through re-export barrels to the module that defines it. It stops at shared pipe modules, infrastructure modules and every `private/index.ts` seam. Its depth is capped at 6. A measurement test prints how many tables each route and loop reaches.

`portal/server/watch-history/engine-blind.test.ts` keeps the registry out of planning: the `data-flow/` folder may import only zod and a short list of contracts modules, and no planning code may import it.

## Not yet built

The coverage rules (every entry point has an entry), the write-evidence checks over the closure, the health reader, `GET /api/data-flow`, `rhen sources` and the Data page are later changes. See [Writing a connection](writing-a-connection.md) and [Writing an add-on](writing-an-addon.md) for the code a new entry describes.
