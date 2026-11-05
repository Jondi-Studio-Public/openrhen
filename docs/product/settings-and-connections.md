# Settings and connections

This guide covers Settings, Connections, Reports and the command line.

## Settings

First setup is three short steps (when you sleep, where you spend your days, the first thing you want planned), each skippable. Nothing saves until the last step, and it never resets an existing plan. **You** lists records, Connections and the settings groups; each group saves on its own:

- **Sleep and routines**: sleep anchors and routines.
- **Planning**: timezone, horizon, usable capacity, buffers, estimates.
- **Places and energy**: locations, capabilities, contacts, energy meanings.
- **Notifications**: leave-by alerts on this device.
- **Disruptions and sharing**: the kinds of disruption you log, and status publishing.
- **AI and add-ons**: which model each AI tool calls, plan map switches, reference codes, and agent tokens.
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

- **Default setup before** and **transition after** a commitment.
- **Minimum submission buffer** and **percentage** before a deadline.
- **Arrival margin**: minutes added to travel before a commitment with a journey.
- **Break after a maximum session**.
- **Default mode** of travel.

Setup time protects getting ready to leave; the journey is protected separately, so trim any setup time that already includes the drive. A leg's mode is decided in order: the commitment's own **Travel by**, the destination's **Usual mode**, the default mode, then whichever mode has a figure. **Lateness matters** (on by default) makes the estimate more cautious.

### Estimates

**Estimate buckets** are quick remaining-effort choices. **Learned calibration** shows how much longer or shorter finished work ran than estimated once five timed actions exist, and scales future estimates for that area. It can be switched off.

### Routines

The routine builder is where preparation tiles are arranged on a board, joined with arrows for real prerequisites, and tied to the commitment they lead to. A tile can stand in for a cadence action so it appears only on days that action is due. A routine preset is not a copy: editing it updates future commitments that use it. **Time bands** name windows of the day (Morning, Afternoon and Evening by default) that a flexible step can prefer.

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

To add one, see [Writing a connection](../architecture/writing-a-connection.md).

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

The CLI talks to `http://localhost:8787` by default; set `OPENRHEN_URL` to point it elsewhere. Under owner sign-in it authenticates with an owner token or a scoped agent token (`rhen agent-token create`); tokens are shown once and can be revoked. `rhen mcp` serves every command as MCP tools for an AI client (point the client's MCP server command at `rhen mcp`). The Docker install does not include `rhen`: it needs Node.js and a checkout, and `corepack pnpm --filter @openrhen/cli build` makes `tools/cli/dist/rhen.mjs`; `corepack pnpm cli` runs it from source. `rhen help [command]` lists everything.
