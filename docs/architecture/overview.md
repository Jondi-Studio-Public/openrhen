# Architecture overview

OpenRhen is a TypeScript workspace of a few small processes around one PostgreSQL database. This page names the processes, what each is allowed to do, and how a change flows through them.

## The processes

| Process | Package | Job |
|---|---|---|
| Portal | `portal/` | The web interface and its HTTP API. Validates requests, commits state, enqueues planning work, renders saved results. |
| Planning service | `engine/service` | A stateless, authenticated HTTP service. The only runtime that executes the planning engine. |
| Worker | `engine/worker` | Claims durable jobs, sends a snapshot to the planning service, saves the result, and runs the scheduled loops. |
| Outbound proxy | `integrations/outbound-proxy` | Makes every third-party call and holds every third-party credential. |
| Database | PostgreSQL 17 | The only store: planning records, jobs, results, evidence, uploaded files. |
| Command line | `tools/cli` (`rhen`) | A client of the portal's HTTP API for people and AI tools. Never opens the database. |

Shared libraries: `platform/contracts` (schemas, commands and wire shapes, validated with Zod), `platform/database` (schema, migrations, jobs, backup and restore) and `engine/core` (the pure planning functions).

## Boundaries that are deliberate

- **The planner is pure.** `engine/core` does no I/O. Given a snapshot of state and a calculation time it returns the same plan every time. Only the planning service imports it; the portal and worker may not, and a boundary test enforces this so there is never a second implementation of the rules. Logic that both sides must agree on (for example matching a requirement to your situation) lives in `platform/contracts` and is shared code, not a second opinion.
- **The database is the source of truth.** The portal never calculates a plan inside a request. A change is validated, written in a transaction with an evidence record, and a recalculation job is queued in the same transaction.
- **Secrets stay out of the portal, with one deliberate exception.** Third-party credentials configured by the operator live only in the outbound proxy's environment; the portal holds the proxy's URL and a bearer token. The exception is a key the person types into the web app (Settings > Passwords and keys, today the YouTube Data API key). The portal stores it in `app_secrets`, sealed with AES-256-GCM under `OPENRHEN_SECRETS_KEY` (the portal's environment only), write-only: no route returns it, no agent route or tool can reach it, and a single helper decrypts it to place it in the body of one proxy request, which sends it to the provider in a header and keeps none. This protects a database dump, a backup or SQL access; it does not protect against a compromised portal process or `docker inspect`, which show the master key. Saving a key needs `OPENRHEN_OWNER_AUTH=require` and the master key set. The JSON backup leaves keys out, and a restore empties the saved keys on the target (it truncates the users table with CASCADE), so keys are entered again afterwards. The database copy taken before a migration (`pg_dump` into `/backups`) holds only the sealed text, and the master key is never in `/backups`. Between portal and proxy the key travels as plain HTTP on the internal compose network, inside the request body, and is not on a published port. This was the owner's decision (2026-11), made so a key can be entered without editing server files.
- **Outside data proposes; you decide.** Imports, captures, model output and connection data become proposals that wait for review. Nothing outside the app can change your plan unreviewed, and untrusted text can never issue a command.
- **Derived mail facts are not plan data.** What a reader extracts from mail (an ask, a promise, an event, a deadline) sits in the activity store and never feeds the planner. Mark sees the open ones in the attention feed (`fact_open`, read:plan) and, when the owner agrees, puts one on the plan with an ordinary save; that save carries the fact's id in the note (`fact_id:<id>` in an action's notes), which is how the feed stops listing it. Mail text in an item is quoted and untrusted.

## How a change flows

```text
Browser or CLI
  -> versioned API command
  -> contract validation
  -> one PostgreSQL transaction:
       optimistic version check
       write normalised records
       append change evidence
       build an immutable planning snapshot
       enqueue a recalculation job
  -> return current saved state

Worker
  -> claim the job (row locking, so no two workers take it)
  -> send the snapshot to the planning service
  -> validate the result
  -> discard it if newer state has superseded the snapshot
  -> save the plan and its evidence
  -> schedule the next recalculation at the plan's earliest validity boundary
```

The browser shows the last saved plan with a freshness label while recalculation runs, and polls a small status endpoint until a newer plan lands. A server-sent-events stream (`GET /api/events`, fed by PostgreSQL `NOTIFY`) tells open tabs when to look, but nothing depends on it: without it, polling does the same job.

Jobs are idempotent by input version, so duplicate triggers collapse. At most one recalculation waits per user. A plan carries an expiry; when the planning service is down the last plan stays readable but is labelled stale, Start is disabled until a valid plan returns, and capture, review and settings keep working. Restarting the service or worker is enough to recover.

## Worker loops

The worker runs independent loops, so a slow one delays only itself: planning jobs, a watchdog that restarts a plan refresh chain that died silently (no active job and no run for 70 minutes, engine not reported down; at most one restart per user per 70 minutes, and it needs the portal), pruning old evidence, the check-in scheduler, leave-by notifications, and each connection's own sync schedule.

## Persistence

PostgreSQL is required. The portal reads `DATABASE_URL` and refuses to serve planning state without it. Migrations are append-only: a correction is a new migration, never an edit. Uploaded source files are stored in the database as bounded records with a content hash, so a backup is one artefact; the payload can move behind object storage later without changing identifiers. Backups are logical, verified by restoring them, and described in [Database and backups](../operations/database-and-backups.md). The append-only Now offer log (`offer_log`) also records what each surface resolved (`shown`, from the open portal tab and the handheld); that is a lower bound on what you saw, since a background tab, a second surface or a missed request leaves no row.

## Closing plan items

Plan items are closed (archived or cancelled), not deleted. Closing records who, when and why, in the database itself, so every path through the portal, the agent tools and imports leaves a closer. Review > Closed lists the result.

- **Close brake.** A rolling hourly limit on closures stops a runaway agent. Undoing a create is exempt, and an agent save that would drop a deliverable step is refused with the exact archive or cancel call.
- **Sources.** A calendar, feed or roster cancel closes the commitment instead of deleting it, and a returning event reopens only rows the import itself cancelled. Ending a recurrence closes its future occurrences; the planner prune spares closed rows.

Known limits:

- A person's own deliverable step drop is still a hard delete.
- A rule end counts 1 toward the brake.
- Closed future dates of an ended rule are never pruned, so those rows only accumulate.
- No add-on hook fires when a commitment is closed ([#55](https://github.com/Jondi-Studio-Public/openrhen/issues/55)).
- Setting an end date still runs the planner prune, which hard-deletes open dates past it.

## Single user

An install has one owner. The portal acts as the first user row, and foreign keys still keep that user's rows apart. With `OPENRHEN_OWNER_AUTH=off` (the default) trust is the network boundary, which is only safe when the portal listens on loopback. With `require`, every API call needs an owner credential, an agent token, or a route-specific token. See [Locking down the API](../operations/locking-down.md).

## Security rules the code relies on

- Secrets live in environment configuration, or (for a key the person types into the app) sealed in `app_secrets`, and never in source, client state, logs, planning evidence, backups or import provenance. A saved key is never returned by any route.
- Imported files, HTML and model output are untrusted. Model extraction preserves uncertainty and cannot commit data.
- Optimistic versions, command ids and transactions prevent stale or duplicate writes.
- Failure evidence may include error classes, timestamps and retry information, never credentials, cookies or private imported content.
- There is no telemetry. The only outbound calls are the ones you configure through connections.

## Where to look in the repository

```text
engine/{core,service,worker}   planning library, service, job runner
platform/{contracts,database}  shared schemas; schema, migrations, backup
portal/                        web app: app/ routes, features/, server/
integrations/outbound-proxy/   connection host and bundled connections
tools/cli/                     the rhen command line
scripts/                       dependency-free repository tooling
```

Dependencies point inward: the portal and worker depend on `platform/*`; `engine/core` depends on nothing; connections depend only on `platform/contracts` and the host's connection API. `corepack pnpm structure:check` enforces these rules. Names are lowercase kebab-case, tests end in `.test.ts`, and generic `utils`, `helpers` and `common` directories are not allowed.
