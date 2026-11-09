# @openrhen/cli

`rhen` is a command line for the OpenRhen portal: a LAN client for the people and AI tools
(Claude Code and similar) that use the household's planning system from a shell. It reads the portal
state through `GET /api/state` and changes it only through the portal's own command routes — it
never touches the database or portal source directly, and every kind of write the portal accepts has
a matching CLI command rather than a generic escape hatch.

## Install and run

From the repo root:

```
corepack pnpm install
corepack pnpm cli status
```

To build a standalone script:

```
corepack pnpm --filter @openrhen/cli build
```

This produces `tools/cli/dist/rhen.mjs`. To put `rhen` on your PATH, either:

```
corepack pnpm --filter @openrhen/cli link --global
```

or alias it to the built file:

```
alias rhen="node <repo>/tools/cli/dist/rhen.mjs"
```

## Configuration

The portal origin is resolved in this order: the `--url` flag, the `OPENRHEN_URL` environment
variable, `url` in `~/.openrhen/config.json`, then the default
(`http://localhost:8787`). The config file also accepts a `timeoutMs`:

```json
{ "url": "http://localhost:8787", "timeoutMs": 10000 }
```

The request timeout is otherwise `OPENRHEN_TIMEOUT_MS` or 10000ms. The portal is unauthenticated,
so the CLI refuses to talk to a host that is not loopback, LAN, or a private-network (VPN) address unless you pass
`--allow-public` or set `OPENRHEN_ALLOW_PUBLIC=1` — a typo in `--url` must not send the household's
planning data across the internet. An `https://` name under a public domain (the portal's Caddy name,
`https://openrhen.example.com`) is checked by address instead: it is accepted when every address it
resolves to is private. That is a guard against typos, not against a hostile name's DNS, which
could answer differently when the request is made. Table output and stderr have control characters stripped, so escape sequences in
mail or other people's text cannot act on the terminal; `--json` output is unchanged.

### Naming the client

`--agent <name>` (or `OPENRHEN_AGENT`) names the client making a request: 1 to 32 characters of
`a-z 0-9 _ -`, lower-cased; `system` and `human` are reserved. It is sent as an `X-OpenRhen-Agent`
header on every request, so the portal records which agent made each change and `rhen changes`
can show it. The name is a self-declared label, not a credential: anything that can reach the portal
can claim any name. (On `changes`, `--agent` is instead the filter on who made the change; only
`OPENRHEN_AGENT` names the caller there.)

### Basis, evidence and tool hints

Every write takes `--basis stated|inferred|observed` and `--evidence "<up to 300 characters>"` (`propose` has its own): `stated` means the person said it in this conversation and should carry their words. They are sent as `X-OpenRhen-Basis` and `X-OpenRhen-Evidence` and stored in the change log (`changes --evidence`); the quote is dropped for email-derived records. Over MCP each tool carries `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, derived from the registry, and results holding mail, other people's or file text come back inside a `--- BEGIN UNTRUSTED ... ---` block marked `_meta.untrusted`. Neither changes what a write does yet.

### Agent tokens

To make the name a credential, set `OPENRHEN_TOKEN` (environment only, never a flag). It is sent as
`X-OpenRhen-Token`, and the portal then takes the agent name from the token. A token in the portal's
database (`rhen agent-token create`) carries scopes (`read:plan`, `propose:capture`,
`write:entity:action`, ...), which the portal enforces by command and entity type: a missing scope is a 403
naming it, a wrong, revoked or expired token is a 401, and ten unrecognised tokens a minute from one address
are a 429. A token from `OPENRHEN_AGENT_TOKENS` (the older environment table) still works and is limited by
its route list. With `OPENRHEN_AGENT_AUTH=require` on the portal, a bare name without a token is refused; a
caller that sends neither is still treated as the owner unless the portal runs `OPENRHEN_OWNER_AUTH=require`,
when every write needs an owner credential too (below).

A write the token may only propose, or whose `directWrites` mode for that entity class is not `on`, is not
applied: the portal files it for the owner and the CLI prints `Filed as proposal <id>, waiting for the owner`
and exits 0 (JSON output carries the `proposal`). With `directWrites` on, a write applies whatever its basis and
can be undone afterwards. Removals (a `remove` flag, ending a span or recurrence, an import delete; not a status
change), settings an agent may not change directly (timezone, setup and the data-flow fields; plan preferences apply
directly for a token with every class on), outward messages and writes above 20 rows are always proposals; `bulk` over 20 rows files one batch proposal listing every
row. Routes with no proposal form (a reply to another person, a mail draft, an import delete, ending a recurrence) answer 403
and say what the agent can do instead (or that only the person can, and where in the portal); every filed
proposal's reason does the same, and its summary names the fields that change, as `field before → after`.

The owner manages tokens: `rhen agent-token create --name companion --scopes scribe [--expires-days 90]
[--direct-writes action=shadow]` prints the token once on stdout (a warning goes to stderr); `list` shows scopes,
modes, last use and expiry, never a secret; `revoke <name|id>` ends one at once. To rotate, revoke and create
again. `--scopes` takes a comma list or a preset: `read-only` (`read:plan`, `read:changes`, `read:proposals`),
`agent-time` (only `write:agent-session`, for a client that reports its sessions: see the agent-time ingest operations note), `scribe` (reads, plus `propose:capture`, `propose:agent-change`, `propose:entity` and `propose:catch-up`) or `assistant` (a scribe
that also holds `write:entity` and the everyday `write:session`, `write:activity`, `write:check-in` and
`write:arrival`, plus `write:undo`, `write:recalculate`, `write:inbox`, `write:disruption` and `write:deliverable`, so it can follow the undo hint every write
result ends with). Tokens made before that change keep their old scopes: create a new one with
`rhen agent-token create --name <name> --scopes assistant ...` and revoke the old, or reconnect the OAuth client. Every `directWrites` class starts `off` for a token made here (`--direct-writes on` turns
every class on); approving an OAuth client turns them all on, and Settings -> Agent tokens has a "Writes apply
directly" switch per token. `shadow` still files a proposal but records that it would have applied. The command is never offered over MCP, and the portal refuses it
for any request that carries an agent identity. Over `mcp --http` each request's own `X-OpenRhen-Token`
header is used; the server's own `OPENRHEN_TOKEN` is never applied to requests.

**Owner token.** `rhen owner-token create [--label laptop]` prints an owner token (`pri_own_...`) once on
stdout; keep it in your secrets manager and set `OPENRHEN_OWNER_TOKEN` in your own shell. The CLI sends it as
`X-OpenRhen-Owner`, and never from a run that names an agent (`--agent`, `OPENRHEN_AGENT`) or holds
`OPENRHEN_TOKEN`; `mcp` strips it from the environment of the tool calls it dispatches. `list` and `revoke
<label|id>` manage owner tokens and enrolled browsers. With `OPENRHEN_OWNER_AUTH=require` on the portal every
write needs this token (or an enrolled browser). An agent process that has it in its environment can use it, so
never export it where an agent runs.

## Commands

- `status` — what to do now, what is running, and what is next; one call for the whole picture. It carries the engine's answer as the Now page shows it from the same planning run (`recommendation`: why, why not the runner-up, what would change it, the planned end, gates, tonight's sleep errors and stay-up offer), the first ten `risks` and the rest of today's plan as `day`, in local time. `--brief` is a compact digest for a small context: plan freshness (including `awaitingRecalculation`), the next three things, session and commitment timing, minutes until sleep, deadlines within 48 hours, the risk count and the inbox count. Either answer gains `attention: {now, decided, call}` only when `now` (blocking data-health items, failed sources, an open check-in and a due catch-up) or `decided` (the owner's decisions on your proposals since your last session) is above zero, from `GET /api/attention?counts=1`; call `rhen_attention` once, and again only if a count rose. `status` reads the open check-in with a peek, so it is not marked shown (and cannot push the pulse toward a lapse). It is left out for the owner view, a `--state-file` snapshot and a failed read. It also shows the engine's planned journey (leave-by, minutes and basis for the travel directive and each commitment) and, for an anchor commitment you are at, whether its hour is `open` or `engaged` (`activity finish` is "I'm free").
- `list <entity>` — list one kind of entity, with filters, `--where field=value`, paging, and `--count`.
- `forecast [--project <id>] [--all]` — plan health per live project, worst first: health, margin (expected and pessimistic), required pace, confidence, reasons and the engine's smallest fixes, plus an `assumptions` block (when the plan was calculated; the wake, energy, location and open-session readings with their age and the same stale verdict as `status`; the aged time-left estimates; and how many travel times the engine assumed). A lapsed self-set date is flagged `lapsed`, not `overdue`. By default only projects that are behind, at risk, overdue or unknown with a date; `leftOut` counts the rest (on track, ahead or undated) and `--all` shows them. Read it rather than `state`.
- `summary [--from <day>] [--to <day>]` — a daily rollup of a past window (both default to today, at most 31 days; YYYY-MM-DD or an offset such as `-7d`): focused minutes by project, sessions by result, actions finished, and sleep nights with planned and actual times. Built from the same state as `history`, so it covers the last 30 days (`sessionsFrom`); check-in answers are not in the state. Read it rather than `state`.
- `search <query>` — find text across actions, outcomes, projects, notes, captures and more in one call; `--entity` narrows the kinds, `--status` filters, `--limit` caps the hits.
- `changes` — what changed in the plan and who changed it (an agent name, `human` for the portal, or `system`): `--since`, `--agent`, `--entity`, `--limit`, `--before` (cursor), `--evidence`, or `--count [--by agent|entity]` for a summary. Read-only; needs the live portal, so it refuses `--state-file`.
- `propose <kind>` — file a change for the person to confirm in the portal Inbox (Captured, From agents) instead of writing it: `--summary`, `--payload-json` or `--from`, `--basis stated|inferred|observed`, `--evidence`, `--coalesce-key`. `entity_command` replays a stored save (`{"command":"save_entity|save_project|save_action","body":{...}}`). Needs `--agent`; 50 pending at most per agent. `proposals [--status] [--limit]` lists your own proposals and how they were decided (`stale` means the record changed first). Both need the live portal.
- `capture <text>` — drop one line into the inbox (`--area` adds a review hint); the cheapest write, which changes nothing in the plan until it is reviewed.
- `show <entity> <id>` — one entity in full, with what it relates to; `--brief` for just the record.
- `map <item>` — one item's neighbourhood: its card, the cards around it, and the derived links between them (tree, dependencies, shared source, place or contact); `--depth`, `--kinds`, `--budget`. Read-only; stored links join once the link store exists.
- `save <entityType>` — create or update one entity from `--from file.json` and/or `--set key=value` (date fields need a UTC offset, e.g. `2026-10-02T09:00:00+10:00`). A new action's missing estimates take defaults, listed in its `assumedFields` until a save names them.
- `arrive <place>` — assert arrival at a saved location by id or exact name; the same
  `current_availability` write the portal's one-tap "I'm at &lt;place&gt;" button sends.
- `wake [--at <time>] [--slept-at <time>]` — record when the person woke and settle last night in one write: a running sleep
  finishes at the wake; otherwise last night's planned sleep is completed (starting at `--slept-at`, or at its planned start,
  reported as `startAssumed`); otherwise the night is logged, which needs `--slept-at`. `--at` defaults to now; both are
  ISO 8601 with an offset, in the past and within 24 hours. A night already recorded for those hours is refused. MCP tool
  `rhen_wake`, scope `write:entity:sleep_log_entry`; applied directly, no proposal.
- `stretch --choice accept|decline|decline_all [--action <id>]` — the person's answer to the stretch offer `status` shows
  (`stretchOffer`): `accept` works on the cut action for a bounded time (the server rechecks the offer and sets the end),
  `decline` skips that action until tomorrow, `decline_all` means no stretches tonight. An agent sends `--basis stated`
  and `--evidence` (the person's own words) with accept or decline; `decline_all` may be inferred. MCP tool
  `rhen_stretch`, scope `write:entity:current_availability`; applied directly, and `undo` reverses it.
- `bulk <entity>` — apply one `--set`/`--patch` change to many records at once, selected by the `list`
  filters, `--ids a,b,c`, or `--targets`/`--targets-json`; `--dry-run` to preview, `--yes` to apply.
- `session <start|alternative|pause|resume|continue|finish|block|did-not-start|feedback|set-start>` — drive a work session. A recurring action is worked through its occurrence: `--action` takes an occurrence id, or the series' title when exactly one occurrence is open (otherwise it lists the ids); the portal refuses a session on the series itself.
- `archive <type> <id> close|restore` and `cancel <type> <id> close|restore` (or `--restore`) — close or reopen one row. Archive: area, outcome, project, action, deliverable, routine preset, condition (place, contact, capability, live) when finished or retired; cancel: outcome, project, action, deliverable, commitment when dropped. Options: `--reason` (an agent gives one), `--expected-version`, `--include-children` (area, outcome, project). A call over 20 rows, one that would pass 20 closures in a rolling hour (counting the call), or one touching something the owner decides, is filed as one proposal; a save that sets status archived or cancelled is refused. Every closed row in `list` and `show` carries its restore call. Over MCP these are `rhen_archive` and `rhen_cancel`; `do` is always required there.
- `undo [--redo|--list] [--id <entry>]` — reverse your latest recorded write, or the one `--id` names (`save`, including a create, which is undone by setting a status that takes it out of the plan, `bulk` (each applied row is its own entry labelled `bulk <kind>: <name>`, undone one at a time, newest first; failed rows, `--dry-run` and the over-20-row batch proposal record nothing), `activity skip-step`/`unskip-step`/`pause`/`resume`, `arrive`, `span add`/`set`; an agent's `stretch`, `session`, `check-in`, `catch-up-settle` and `inbox-act captured confirm` / `email-act confirm`, which the portal reverts from rows it saved, only while nothing they touched has changed since: undoing a confirm removes what it created and puts the item back in the Inbox; only the owner can force these) or reapply it; the record lives in `~/.openrhen/undo-log.json` (last 50 writes); over the remote `/mcp` it lives in the portal, 100 writes per agent, and Review -> Agent changes shows it. Undo only reverses your own writes (your token, else your `--agent` name, else the shared `unlabeled` owner, the same order the portal names the actor): another owner's newer writes are skipped, not refused, and `undo` errors only when none of the recorded ones is yours (`--any-owner` takes another's anyway). It never overwrites a later edit: it sends the version the write left, so a record changed since is reported as "changed since; not undone" (`--force` overrides, and is needed for entries written by an older CLI; it can also put back a deleted span, project, action or other whole-record save, but not a skipped step or a paused session). A write whose record is gone and cannot be put back (a skipped step, an added span) is dropped with an error, shown as `superseded` by `undo --list`, so the next `undo` reaches the older write; a forced undo or redo that deletes or recreates a record also makes every other recorded write for it need `--force`. `--redo` reapplies the write undone last. Ownership guards against accidents; it is not a security boundary: `--any-owner` is a plain flag, everyone without a token or `--agent` shares `unlabeled`, entries recorded before owners existed match any caller (protected only by needing `--force`), and rotating the token changes the owner.
- `activity <start|switch-step|pause|resume|finish|skip-step|unskip-step>` — drive a routine, commitment, sleep, or deliverable session (`start` needs `--minutes`, 1 to 1440; for a routine step, sleep plan or deliverable step exactly the minutes the plan gives it, which `status` shows); `finish` accepts `--ended-at <iso>` for session reconciliation, and `start` accepts `--started-at <iso>` (also on `session start`) to backdate a start within 24 hours.
- `span <add|list|set|remove>` — a labelled block of calendar days (a trip, days off sick) shown as a band on the History calendar and nothing more: it never blocks time or changes the plan. `add --title <t> --start <YYYY-MM-DD> [--end <date>] [--window HH:MM-HH:MM] [--project <id|title>]`; `set`/`remove` take an id or exact title. `span list` and `list spans`/`show span` read them; under `--read-only` use the latter two.
- `history [--from <day>] [--to <day>]` — a day is `YYYY-MM-DD`, `today`, `yesterday` or an offset in days such as `-7d`; `--from` cannot be after today. Sessions, sleep, closed recurring occurrences and spans for a range of days. Spans cover the whole range; the portal keeps sessions, sleep and occurrences for 30 days, so those are clamped, the output names the start as `sessionsFrom`, and a one-line notice prints when `--from` is earlier.
- `deliverable <sub> [id]` — coordinate a deliverable's workspace from a desktop AI app or CLI agent: `next` (no id) names the one to pick up, then hand off, read the pack, record progress, submit and wait on a result, and drive the same workspace moves the built-in chat has.
- `check-in <on-track|deviated|unknown>` — answer the pending check-in.
- `attention [--since <cursor>]` — what needs the agent or the owner now, ranked, with the exact next step (`nextCall`, or `askOwner` when only the owner can answer); read-only, never acts. Outside text (record titles, the owner's notes) appears only under `quoted`, so over MCP the whole answer is fenced. Pass the last answer's `cursor` as `--since`. Needs the live portal. Over MCP it is `rhen_attention`, read after `rhen_status` shows attention.
- `disruption <start|extend|finish|status>` — log, extend, finish, or check the day's disruption: anything unplanned you are doing now, a meal included (`disruption start --title "Lunch" --duration 30`); `--source` is one of `work`, `family`, `life_admin` or `other` (default `other`; a visitor is `family` or `other`).
- `recalculate` — ask the engine for a fresh plan.
- `cadence complete <action>` — record a cadence completion.
- `recurrence <set|end>` — change a commitment series, or end a recurring action's goal. Travel fields, per series or on one occurrence via `save commitment`: `--set latenessMatters=false` (boolean) and `--set transportMode=car|bike|walk` (`transportMode=null` clears it to usual). A series on several weekdays is one rule: `--set repeat.unit=weeks --set repeat.intervalWeeks=1 --set 'repeat.weekdays=[2,4]'` (0 = Sunday to 6 = Saturday; the start date must fall on a listed day), beside `repeat.unit=days` and `repeat.unit=months`.
- `import <list|preview|show|update|commit|delete>` — bulk-create through the reviewed import flow.
- `state` — dump the whole portal state as JSON, or one top-level key of it. Over the remote `/mcp` server a `--key` is required and an answer over 64 KB is refused (use `status`, `list`, `show`, `search` or `history`).
- `schema [name]` — the JSON schema of an entity or a write command's payload.
- `guide [topic]` — the domain vocabulary and working recipes (topics: vocabulary, workflows, writing-data, reading-data, recurrence, limits, coordinating).
- `skill` — print the agent skill (SKILL.md) for working with OpenRhen; over MCP it is `rhen_skill`; `skill --remote` prints the version for an agent on the portal's remote `/mcp`, which serves fewer tools. Save it as `<skills folder>/openrhen/SKILL.md`; in PowerShell: `node dist/rhen.mjs skill | Set-Content -Encoding utf8 SKILL.md`.
- `help [command]` — usage for the CLI or one command.
- `version` — the package version, git commit and build time, script path, and Node/uptime info.
- `self-update [--check]` — replace this bundle with the one the portal serves (sha256 and banner checked, started once with an empty environment before the swap; old file kept as `<script>.bak`). It downloads only over HTTPS (or from this machine), because the sha256 comes from the same portal as the bytes: point the CLI at `https://openrhen.example.com` to use it. `--check` works over plain http. Every command writes a one-line stderr note when the bundle differs from the portal (a portal rolled back by tag also triggers it; `self-update` shows `from → to`); this is the fix, run on purpose, never automatic. A long-lived stdio MCP process keeps the old code until its client restarts it.
- `owner-token <create|list|revoke>` — the owner's own tokens and enrolled browsers (see Owner token above); not an MCP tool.
- `agent-token <create|list|revoke>` — the owner's tool for scoped agent tokens (see Agent tokens above); not an MCP tool.
- `mcp` — serve every command above as MCP tools over stdio (default) or, with `--http`, over loopback Streamable HTTP for a client that cannot spawn a local process. `--allow-writes a,b` serves only those write tools (every read tool stays) and `--deny-writes a,b` hides the named ones, e.g. `--allow-writes capture,session,check-in` for an agent you trust with less; the scope is per tool, so `save` can still write any entity type. A tool that succeeds but writes notes to stderr (write summaries, contract warnings) returns them as a second text block, "Notes from the CLI:". A write that gets no HTTP answer (timeout, dropped connection) is retried once with the same command id, which the portal's command receipts apply at most once; if it still fails, the error names the id, and repeating with `--command-id <uuid>` (an argument on every mutating MCP tool too) is safe. `bulk`, `email-act --thread` and `disruption start` derive one id per write from the key. Replies to other people and mail draft requests carry no command id, so they are not covered.

Every write echoes a one-line summary, supports `--dry-run` (print the exact payload, send nothing),
and is validated against the shared contracts before it is sent. A change that touches more than one
entity — committing an import, rewriting a recurrence series — additionally requires `--yes`. There
is no delete: close a record with `archive` or `cancel` (each with `close` or `restore`), not a status set through
`save`; a capture is hidden by `ignored`.

Examples:

```
rhen status --json
rhen list actions --status planned,active --sort deadlineAt
rhen show project "Thesis"
rhen show routine-preset preset-gym
rhen save capture --set "text=Book the dentist follow-up"
rhen cancel commitment <id> close --reason "<why>" --dry-run
rhen arrive ctx-gym
rhen wake --at 2026-09-04T07:30:00+10:00 --slept-at 2026-09-03T23:40:00+10:00
rhen bulk action --status pending --where "scheduledEnd<2026-09-04" --set status=skipped --dry-run
rhen session start
rhen session finish --outcome progress --remaining 20
rhen import preview --from records.json
rhen import commit <batchId> --yes
rhen state --key planning
rhen schema action
```

## Output

Every command defaults to a table. `--json` prints structured data instead; `--jsonl` prints one
compact JSON object per row for commands that list rows. `--fields a,b` narrows the columns shown (or
the JSON fields returned), and dotted paths such as `steps.length` are allowed. Tables truncate long
text to stay readable; JSON output never does. Every row a command prints carries its `id`. Dates are
ISO 8601 in JSON and in tables alike, always carrying the planning timezone's own offset (e.g.
`2026-09-04T18:30:00+10:00`), not raw UTC — `rhen status --json` names that zone under
`timezone`. `rhen state`, the raw state dump, is the one exception: its instants are left
exactly as the portal stored them.

`list` keeps a large result manageable instead of making you fetch everything and filter yourself:
`--limit`/`--offset` page through it, `--where field=value` (or `field!=value`, or a comparison —
`field<value`, `field>value`, `field<=value`, `field>=value`, compared as a date when the field looks
like one, else numerically or lexically; repeatable, comma-separated values on `=`/`!=` match any)
filters on any field, and `--count` (optionally `--by field`) answers an audit question with counts
instead of rows, e.g. `list actions --count --by schedulingMode`. `show <entity> <id> --brief` skips
related entities, and any relation list over 20 rows is capped with a note on how to see the rest
(`--all`, or the `list` command it names). Over MCP, `rhen_list` additionally defaults to a
50-row cap when the caller passes no `--limit`. `bulk <entity>` uses the very same filters (plus
`--ids`/`--targets`) to apply one change to every match at once — see its own help for details.

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | ok                                                                      |
| 1    | usage — bad arguments, an unknown command, or an unusable configuration |
| 2    | validation — the portal rejected the payload; details carry its issues  |
| 3    | conflict — the entity changed since it was read; re-read and try again  |
| 4    | not found — the entity or route does not exist                          |
| 5    | unavailable — the portal is unreachable, timed out, or failed           |

## For AI tools

Start with `rhen guide` for the domain vocabulary and recipes, `rhen help --json` for the
whole command table, and `rhen schema` for the names of every entity and write-command payload —
`rhen schema <name>` then prints one as JSON Schema. Ids are universal: any id a command prints
is accepted by every other command that takes one, and filters such as `--project` or `--action`
accept a title as well as an id. `rhen status --json` is the one-call summary of the present
moment, worth reading before anything else. Over stdio MCP (`rhen mcp`), every command except `mcp` and the owner-only ones, `help`
included, is served as a tool (`rhen_help`, `rhen_free`). The portal's remote `/mcp` serves fewer: no `help`,
`schema`, `version`, `free`, `import`, `self-update` or the token commands (`skill --remote` prints the matching skill;
`free` is `rhen_save_commitment` with `free: true`). Both servers announce the same starting points in its `initialize`
response's `instructions`, so a client that surfaces those needs no separate onboarding doc.

Desktop AI apps that speak MCP connect through `rhen mcp`, which serves each command as a tool
named `rhen_<command>`. For Claude Desktop, after building, add to the MCP server config:

```json
{
  "mcpServers": {
    "rhen": {
      "command": "node",
      "args": ["/path/to/OpenRhen/tools/cli/dist/rhen.mjs", "mcp"]
    }
  }
}
```

Over MCP a model may be reading untrusted mail, so file-path options (`--from`, `--patch`, `--targets`,
`--dir`) are refused unless the server's environment sets `OPENRHEN_MCP_FILES_DIR`, and then they must
name a path inside that directory. Pass content inline instead (`--set`, `--targets-json`). Values from
the model are always passed as data, after a `--`, so none can change the server's own `--url`,
`--read-only` or `--agent`.

Give each client its own name with `--agent`, so the change log tells them apart:
`"args": [".../rhen.mjs", "mcp", "--agent", "mark"]` applies it to every tool call the server
dispatches (`--watch` forwards it too). It is a label, not a credential. Over `mcp --http` one process
serves several clients, so `--agent` is refused there; each request names itself with the
`X-OpenRhen-Agent` header instead (an invalid value is an HTTP 400). `rhen_changes` reads the
change log: start with `count`, or a short `since`.

Call `rhen_version` any time to confirm which build is actually answering — useful after a
rebuild, since `serverInfo.version` in `initialize` (`0.1.0+<commit>`) and the `version` command read the same build
stamp (package version, git commit, build time).

## Coordinating a deliverable from a desktop AI

A deliverable is a project's own reviewable body of work — an essay, a report, code, a spreadsheet — with a step plan, deadline, success criteria, and a transcript. The portal itself has a built-in chat for coordinating one, but a desktop AI app already on your PC (Claude Code, Claude Desktop) with your own subscription, tools, and file access can do the same job without per-turn costs, and can actually read and edit the real files instead of working with summaries.

With no deliverable in hand, `rhen deliverable next` names one to pick up: the current directive's deliverable if the engine is already recommending one, else the highest-ranked eligible deliverable, with its handoff prompt ready to use.

Start with `rhen deliverable handoff <id>` or the portal's "Coordinate in a desktop AI" button — both print a prompt to paste into your desktop app. The app then runs `rhen deliverable pick-up <id>` (optionally `--tool "Claude Code"` to tag the session), which records the handoff and prints the full context pack: the deliverable's facts, deadlines, criteria, steps with status and readiness, blockers, sources, and a capped transcript, followed by the rules and a command map.

From there, drive the work through the workspace moves: `add-to-breakdown`, `approve`, `extend-plan`, `complete-steps`, `begin-review`, `record-review`, `record-blocker`, `resolve-blocker`, and `submit`. Use `note` between moves to record progress the person sees live; when done, run `drop-off --summary "…"` to close the handoff and hand control back. To download every retained source file and captured text to disk — the whole point of having desktop file access — use `rhen deliverable export-sources <id> --dir <path>`. Every write validates locally, supports `--dry-run`, and prints a one-line summary. `rhen guide coordinating` has the standing rules and the revision-loop recipe if work comes back needing changes.

Once every required step is done, `submit <id> --waiting-for "…" [--category …] [--proposed-resolution "…"]` records what is being waited on as an open blocker and moves the deliverable to `awaiting_result`, where the engine stops recommending it. `resolve-blocker --feedback "…"` clears the wait when the result arrives — the feedback is retained as a source Review can cite — and returns the deliverable to `under_review` once every open blocker has cleared, so `record-review` can run against real evidence instead of a guess. `activity finish` can end a session and `save deliverable --set status=completed` can write completion directly from the command line, but both bypass the browser's confirmation, so prefer letting the person confirm completion there.

Examples:

```
rhen deliverable next
rhen deliverable handoff deliverable-chapter
rhen deliverable pick-up deliverable-chapter --tool "Claude Code"
rhen deliverable complete-steps deliverable-chapter --steps step-outline,step-write --evidence "Both sections drafted"
rhen deliverable submit deliverable-chapter --waiting-for "the marker to grade it"
rhen deliverable drop-off deliverable-chapter --summary "Draft written, awaiting review"
```

### Claude Code over HTTP (no local install)

Claude Code can use the portal's remote `/mcp` directly. Add it once, sign in through the OAuth page the first time a
tool is used, then have the agent call `rhen_skill` at the start of a session for the current rules. The server
serves that text, so nothing is saved into a skills folder and it follows the server:

```
claude mcp add --transport http openrhen https://openrhen.example.com/mcp
```

Every `initialize` reports `serverInfo.contractVersion` (`AGENT_CONTRACT_VERSION`); `rhen_guide` and
`rhen_skill` start with the same number.

### Remote clients: `mcp --http`

A client that takes a remote MCP endpoint rather than spawning a local process (ChatGPT desktop's
connectors, for example) can reach the same tool table over `rhen mcp --http [--port n]`
(default port 8834). It binds `127.0.0.1` only, refuses any request whose `Origin` or `Host` header is
not loopback, and requires `Authorization: Bearer <token>` — from `OPENRHEN_MCP_TOKEN`, or generated
at startup if unset (printed on a terminal, otherwise written to `~/.openrhen/mcp-http-token-<port>`: mode
0600 on macOS and Linux; on Windows it is stored under your user profile, protected by its permissions). A request body over 1 MB or a batch of more than 50 calls is refused. `--watch` stays stdio-only: an HTTP client reconnects on its own,
so there is nothing for a supervisor to bridge.

### Development: `mcp --watch`

`rhen mcp --watch` (or setting `OPENRHEN_MCP_WATCH=1` when a client config is awkward to
edit) puts a small, stable supervisor in front of the server. The supervisor is what the MCP client
actually launches; it spawns the real server as a child process and pipes the client through it
unchanged. When the running script file (the built `dist/rhen.mjs`) changes on disk — i.e. you
ran `pnpm --filter @openrhen/cli build` again — the supervisor transparently swaps in a freshly
spawned child: it replays the client's original `initialize`/`initialized` handshake into the new
child without exposing that replay as a second response, then tells the client to refresh its tool
list (`notifications/tools/list_changed`). Any request that was in flight on the outgoing child when
it had to be killed gets an immediate JSON-RPC error (`-32000`, "server restarted, retry") so the
client never hangs; a child that crashes on its own is relaunched with backoff (1s, 2s, 5s, then the
supervisor gives up and exits). This is development-only — restarting costs a brief pause on whatever
request lands mid-swap, and there is no reason to pay for a supervisor process in production, where
the bundle never changes underneath a running server. Point Claude Desktop at
`["dist/rhen.mjs", "mcp", "--watch"]` while iterating on the CLI and it survives every rebuild
without needing to reconnect the client by hand.

## Status

Complete as of 2026-09-04: reads, writes, the domain guide, and the MCP server over the same command
table. Reads go through the portal's state route; every write goes through its validated command
routes, so version checks, receipts, the change log, and plan recalculation all apply exactly as they
do from the browser.
