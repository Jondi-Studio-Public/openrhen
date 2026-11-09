# Settings and connections

This guide covers Settings, Connections, Reports and the command line.

## Settings

First setup is three short steps (when you sleep, where you spend your days, the first thing you want planned), each skippable. Nothing saves until the last step, and it never resets an existing plan. **You** lists records, Connections and the settings groups; each group saves on its own:

- **Sleep and routines**: sleep anchors and routines.
- **Planning**: timezone, horizon, usable capacity, buffers, estimates.
- **Places and energy**: locations, capabilities, contacts, energy meanings.
- **Notifications**: leave-by alerts on this device.
- **Disruptions and sharing**: the kinds of disruption you log, and status publishing.
- **AI and add-ons**: which model each AI tool calls, plan map switches, reference codes, and agent tokens; its second tab, **Mail understanding**, sets where the model that reads your mail runs ([below](#mail-understanding)).
- **Passwords and keys**: keys the app needs for outside services (the YouTube Data API key and the hosted model API key), saved encrypted and never shown again.
- **Sign-in and devices**: the browsers and phones signed in as you.

### Sleep, time and capacity

- **Timezone** and **date format**.
- **Preferred bedtime and wake time**: anchors for a stable routine.
- **Desired sleep**: the normal protected duration.
- **Absolute minimum sleep**: a hard floor that only a confirmed fixed commitment can breach, shown as a prominent warning.
- **Maximum awake hours**: a hard limit from waking to the next sleep.
- **Bedtime deviation**: how far the fullest night may start before your preferred bedtime before it warns and offers a nearer night (180 minutes by default).
- **Recovery time**: a daily window on chosen weekdays where only **Recovery only** actions are offered. **Skip today** on Now frees one day.
- **Usable free time %**: the share of free time treated as realistically usable. Roughly 75 to 85 percent leaves room for breaks and small delays.

### Conditions

The catalogue of places, capabilities, contacts and live commitments that work may require. A place grants the fixed equipment and people found there. A portable capability travels with you. A contact reachable by message or call is available anywhere. A **live** condition is satisfied only while a named commitment (recurring or one-off) is running. Condition names must match between actions, routine steps and the catalogue.

### Buffers and travel

- **Setup before** and **transition after**: the starting values for new commitments; they do not change existing ones.
- **Minimum submission buffer** and **percentage** before a deadline.
- **Arrival margin**: minutes added to travel before a commitment with a journey.
- **Break after a maximum session**.
- **Default mode** of travel.

Setup time protects getting ready to leave; the journey is protected separately, so trim any setup time that already includes the drive. A leg's mode is decided in order: the commitment's own **Travel by**, the destination's **Usual mode**, the default mode, then whichever mode has a figure. **Lateness matters** (on by default) makes the estimate more cautious.

### Estimates

**Estimate buckets** are the quick remaining-effort choices shown as chips beside Remaining minutes in the action editor. **Learned calibration** shows how much longer or shorter finished work ran than estimated once five timed actions exist, and scales future estimates for that area. It can be switched off.

### Routines

The routine builder is where preparation tiles are arranged on a board, joined with arrows for real prerequisites, and tied to the commitment they lead to. A tile can stand in for a cadence action so it appears only on days that action is due. A routine preset is not a copy: editing it updates future commitments that use it. **Time bands** name windows of the day (Morning, Afternoon and Evening by default) that a flexible step can prefer.

### Mail understanding

**Settings > AI and add-ons > Mail understanding** says where the model that reads mail runs. Fields: the **Ollama address** (an IP address and port on your network or tailnet, such as `http://192.168.1.20:11434`), the **local model** and **hosted model** names, **hosted messages a day** and **hosted tokens a day** (counted over the last 24 hours; 0 stops hosted sends), and **days to look back**. The card shows the hosted sends so far against those limits and whether the hosted model provider's key is saved. **Test local model** and **Test hosted model** send fixed made-up text, never mail, using the settings as last saved; a hosted test counts as one send. When the local test fails, the card shows the reason and two PowerShell lines that make Ollama listen on the saved address (not on every address) and open its port for private networks.

The hosted tier is guarded by a deny-list, which is reactive: the first mail from a new sensitive sender can reach the hosted model before that sender is known, and the card says so. The hosted model provider (currently DeepInfra, the connection the card names) publishes a policy (linked from the card) not to log request content, to delete it after answering and not to train on it; that is how every request is handled, so there is no switch in the app or the provider account. Models from makers the provider lists (Google and Anthropic on DeepInfra) are the exception (their own policy applies), and the app refuses to send mail to them. This is a published policy, not a signed agreement; model pages marked "Zero retention" are the safest choice.

### Passwords and keys

**Settings > Passwords and keys** holds keys you type in rather than put in server files. Each is a password field with **Save** (or **Replace**) and **Remove**; the page shows only *Saved 6 Nov*, *Saved but unreadable: re-enter* or *Not set*, and never shows a key back, to you or to an agent. To change a key, replace it. There are two: the **YouTube Data API key** (create a key for the YouTube Data API v3 in the Google Cloud console), which lets Review look up how long your watched videos are, and the **hosted model API key**, for the hosted model in [Mail understanding](#mail-understanding); mail understanding reads it from here only and ignores any provider key set as an environment variable (search embeddings still use `DEEPINFRA_API_KEY`).

Saving needs two things, and the page says which is missing and exactly how to set it: `OPENRHEN_SECRETS_KEY` in `.env` (32 random bytes, base64; `node scripts/setup/init-env.mjs` makes one and never replaces it), and `OPENRHEN_OWNER_AUTH=require` ([Locking down the API](../operations/locking-down.md)), because with sign-in off anyone who can reach the address could replace or delete a key. Keys are sealed with AES-256-GCM under the master key, so a database dump, a backup or SQL access sees only sealed text. It does not protect against someone who controls the running portal, or who can run `docker inspect` on it (both see the master key). The JSON backup leaves keys out, and a restore deletes the keys already saved, so after restoring enter them again; the database copy taken before an upgrade (in `/backups`) holds only the sealed text, and the master key is never stored there. If the master key changes, saved keys show *unreadable* and must be entered again; there is no other rotation.

### Notifications

Leave-by reminders reach a phone once this page turns them on, one subscription per device. Setup is in [Web push](../operations/web-push.md). A phone can also report its location automatically; see [Location ping](../operations/location-ping.md).

### Status publishing

If a status endpoint is configured, **Settings > Pulse** sends a redacted on-plan/off-plan reading to it: never a location, an id or the title of a private item. A live preview shows exactly what the next publish would send. Areas and projects marked **Private** are never included.

## Connections

**Connections** (under **You**) is diagnostics; it never changes planning records. Its answer line names anything not working. Each connection is a row with an **On**, **Setup** or **Off** badge; open one for its sheet: configuration status (never secrets), a **Test** or **Sync now** action, and the last run. The database line shows the PostgreSQL version and latency, and the **Planner** sheet shows whether the planning service and worker are reachable.

Below those, one card per outside provider reports what the app's own calls have cost: reachability, average response time (and time to first token for streamed replies) over the last 24 hours, call counts by kind, and tokens where relevant. Reachability is measured passively first: a real call within five minutes is proof; otherwise a rate-limited check prefers real work over a synthetic probe.

Bundled connections:

- **Google Calendar** (read-only): reads events from the calendars you choose and syncs on a schedule. Changes to events no other source feeds are applied; new events and conflicts wait in the Inbox under Calendar.
- **Google routes**: travel-time estimates, limited by a shared daily lookup budget shown on Now.
- **OpenAI** and **DeepInfra**: language-model providers for extraction, chat and embeddings.
- **Pulse**: the status publisher described above.
- **YouTube Data API**: video lengths for [watch history](building-the-plan.md#watch-history). It needs no server setting: the key you save under Passwords and keys is sent with each request, and the proxy keeps none.

To add one, see [Writing a connection](../architecture/writing-a-connection.md).

## Data

**Data** (under **You**, `/data`, linked from the Connections and You headers) is a live map of every data point: where it comes from, where it is stored, what reads it and what that gives you. It is read-only and draws only from the code's registry and the health the server reads, so it cannot drift from what the app does. The header carries a counts line ("4 late · 1 device silent · 11 collected, unused · 5 accepted, nothing sends") that links to it.

Five columns run left to right: outside systems and devices, collectors and shared pipes, stores (tables that share the same readers and writers are drawn as one; the activity store opens into one row per source), readers, and what it gives (pages, the planning engine, tools, push). Each node shows a dot, its status in words and its age, so colour is never the only signal: green is fresh, amber is late or unused, red is stale, failing or a check that cannot run, grey is not tracked or not set up, hollow has never been heard from. Solid lines reach the planning engine; dotted lines are data the engine is blind to on purpose. Backup and raw REST are greyed as pass-through. Planned sources sit dashed in their own lane under the map.

Filter by category, **Reaches the engine**, **Problems only**, **Show planned** and, when a private build adds its own entries, **Core** or **Private**. Open any node for its id and method, what it gives, what it could give, the tables it reads and writes, the live kinds against the registered ones, how it runs and its warning thresholds, credential names (never values), last success, last attempt and last error (shown as plain text, since it comes from outside), and the code behind it. The page reads again every minute while it is visible and stops while the tab is hidden. If the health read fails it says "Health unavailable" over the last graph it had and recovers on the next good read. Under 720 px the map becomes a list, problems first, each row a `from → via → to → reaches` strip. See the [data-flow registry](../architecture/data-flow-registry.md).

## Reports

**Reports** lists every issue you captured with **Report issue**, outstanding first. Once a problem is dealt with, press **Mark reviewed** and write a line saying what changed. **Reopen** puts it back. Reviewing records a verdict only: the captured evidence is never edited, so a reviewed report still replays exactly as reported.

## The command line

`rhen` is the same system from a shell, for you or an AI tool working for you. It reads the portal over HTTP and writes only by sending the portal's own commands, so a change made there is validated, versioned, recorded in the change log and replanned exactly as one made in the browser. It never opens the database.

It covers the current directive, listing and showing records, saving one or many, work and routine sessions, check-ins, disruptions, cadence completions, imports, undo, and asking for a fresh plan. Every write echoes what it did, says `applied` true or false (a `--dry-run` is always false) with its command id, and accepts `--dry-run`; a command touching more than one record needs `--yes`. There is no delete: removal is a status change.

```text
corepack pnpm cli status
rhen list actions --status planned,active --sort deadlineAt
rhen capture "Book the dentist follow-up"
rhen session finish --outcome progress --remaining 20
```

The CLI talks to `http://localhost:8787` by default; set `OPENRHEN_URL` to point it elsewhere. Under owner sign-in it authenticates with an owner token or a scoped agent token (`rhen agent-token create`); tokens are shown once and can be revoked. `rhen mcp` serves every command as MCP tools for an AI client (point the client's MCP server command at `rhen mcp`). The Docker install does not include `rhen` as a command, but the portal serves it: with Node.js installed, `curl -o rhen.mjs http://localhost:8787/api/cli/bundle` then `node rhen.mjs help` (no checkout or pnpm). From a checkout, `corepack pnpm --filter @openrhen/cli build` makes `tools/cli/dist/rhen.mjs`, and `corepack pnpm cli` runs it from source. `rhen help [command]` lists everything.
