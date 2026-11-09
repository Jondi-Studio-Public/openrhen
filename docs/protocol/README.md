# Protocol: seams and architecture

**Status: v0.** The agent surface and the engine wire are what an outside tool can build against, and they are called v0: there is no compatibility promise beyond the rules that already exist and are tested (a renamed agent tool keeps its old name for one contract version; stored requests gain fields only with defaults). Everything else here is an add-on interface that is built into the app at build time, not a network protocol. What "stable" will mean is decided when a second implementer exists.

Pages: this one (seams, architecture, verifying an add-on), [Versions](versions.md), [Auth](auth.md), [Proposing changes](changes.md). Behaviour rules for a particular kind of connection live with the connection's own design, not here.

## Seams

A seam is a place the core is meant to be extended without editing core files. A seam with no test is labelled `unstable`: expect it to move.

| Seam | Owner | Status | Test |
|---|---|---|---|
| Bundled connections (`integrations/outbound-proxy/src/connections/<id>/`, manifest in `platform/contracts`) | core | exists | `integrations/outbound-proxy/src/host/conformance.test.ts` |
| Connection manifest `version` field | core | exists | `platform/contracts/src/connections/manifest.test.ts` |
| Proxy drop-in folders (`integrations/outbound-proxy/src/drop-ins/<name>/register.ts`) | core | exists | `integrations/outbound-proxy/src/host/build-entries.test.ts` |
| Connection registry (`registerConnection`) | core | exists | `integrations/outbound-proxy/src/host/connection-registry.test.ts` |
| Calendar diff profiles (`registerDiffProfile`) | core | exists | `portal/server/persistence/postgres/imports/calendar-diff-registry.test.ts` |
| Import extensions (`portal/server/persistence/postgres/imports/import-extensions.ts`) | core | exists | `portal/server/persistence/postgres/imports/import-extensions.test.ts` |
| Contracts extension registry (`registerContractsExtension`: routes, scopes, tools added to the shared contracts) | core | exists | none: unstable |
| Command-line drop-ins (`tools/cli/extensions/<name>/command-module.ts`) | core | exists | none: unstable |
| Agent tools and scopes | core | exists | `platform/contracts/src/agent-contract.test.ts` |
| Engine wire (`POST /v1/plan-and-forecast`) | core | exists | `engine/service/src/server.test.ts` |
| Backup format | core | exists | `platform/database/src/operations/backup-format.test.ts` |
| Example add-on and its CI job (`addon-conformance`) | core | exists | `scripts/addon/conformance.test.mjs` |

The single-slot stub files an add-on replaces (portal, worker, database, contracts) are listed once, in `scripts/repository/seams.json`; the add-on's own files (compose, env, pages, navigation, migrations) are in the recipe. For the recipe, see [Writing an add-on](../architecture/writing-an-addon.md) and [Writing a connection](../architecture/writing-a-connection.md).

Tools an add-on adds to the agent surface go through the contracts extension registry; core owns every other tool.

## Architecture

Layers, from the inside out:

```text
core (this repository)
  engine/core          pure planning functions, no I/O, imports nothing of ours
  platform/contracts   schemas, wire shapes, manifest, agent contract, extension registry
  platform/database    schema, baseline migration, backup and restore
  engine/service       HTTP wrapper around engine/core (the only runtime that runs it)
  engine/worker        jobs and sync loops
  portal               web app and HTTP API
  integrations/outbound-proxy   connection host; holds every third-party credential
  tools/cli            rhen: command line and MCP server, a client of the portal API
add-on (a separate, private or public tree, built on a pinned core)
  connections, drop-ins, tables and migrations, pages: added files only, at the seams above
```

Import rules, enforced by `corepack pnpm structure:check`: `engine/core` imports no workspace package; only `engine/service` imports `engine/core`; the portal and worker depend on `platform/*`; a connection imports only `platform/contracts`, its own folder and the host's `connection-api`, `http` and `cookie-jar`; the CLI never opens the database. The same command runs the vendor-term ratchet (`scripts/repository/rules/vendor-terms.mjs`): core names no provider, the term sets in `rules/vendor-terms.json` only grow, and the hits that remain are counted per lane in `scripts/repository/pending/vendor-terms/`, where a count can only go down (`corepack pnpm structure:check --fix-pending` rewrites the counts after you remove hits). Core code names a provider only through the registry or a drop-in folder, never directly. See the [architecture overview](../architecture/overview.md) for what each process does.

How an add-on attaches at build time:

```text
pinned core  ->  add-on files copied over it at the documented seams  ->  build  ->  images
  (nothing in core is edited; a connection or profile registers itself on import)
```

An add-on is built with the core, so a seam change in core can break an add-on at build time, not at run time. That is why seam changes carry a changelog line (see [Proposing changes](changes.md)).

## Agent surface

The agent surface is the MCP server and CLI (`rhen`). It is v0 with these tested rules:

- The served tools and their required arguments are committed in `platform/contracts/src/agent-contract-snapshot.ts` and checked by `agent-contract.test.ts`. Adding, removing or renaming a tool, or changing a required argument, fails the test until `AGENT_CONTRACT_VERSION` is bumped and the file regenerated (`corepack pnpm --filter @openrhen/cli contract-snapshot`).
- A renamed tool keeps its old name as an alias for one contract version, then the alias goes. An alias (and a tool folded into another) is callable by name but unlisted: `tools/list` does not show it.
- Public tool names are `rhen_<command>`, for example `rhen_state`, `rhen_guide` and `rhen_save_action`; the server reports its `contractVersion` in the MCP `initialize` result. `rhen schema` prints the argument schema of each command.
- Writes by a token that only holds `propose` scopes land in the Inbox for the owner to confirm. See [Auth](auth.md).

## Verify your add-on

Run these from a checkout with the add-on in place:

```text
corepack pnpm structure:check
corepack pnpm --filter @openrhen/outbound-proxy test
corepack pnpm --filter @openrhen/contracts test
corepack pnpm --filter @openrhen/portal test
```

What they cover, and what they do not:

- The connection conformance test checks every connection registered when it runs: each manifest is bound once, implements exactly its declared operations, and answers empty input and a failing network with a well-formed failure.
- Diff profiles are checked by `describeProfileConformance` in `portal/server/persistence/postgres/imports/calendar-profiles/profile-conformance.ts`. Call it from your own test file with an entry for your profile (a fixture event and an echo fixture). A coverage test in the core fails if a profile the core registers has no entry. It only covers profiles registered in the process under test: a profile registered lazily, after that process has started its tests, is not covered.
- The agent contract test covers the tools registered at import time, including those an add-on adds through the extension registry.
- None of these prove a drop-in replacement for the portal or the engine; they check this repository's own rules.
