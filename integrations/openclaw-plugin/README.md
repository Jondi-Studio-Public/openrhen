# OpenRhen plugin for OpenClaw

One install gives OpenClaw the OpenRhen MCP connection, the `openrhen` skill that teaches the agent to
use it, and agent-time reporting. The plugin has no dependencies: `openclaw.plugin.json` declares the remote
server and the skill folder, and `index.js` with `agent-time.js` is the only code.

| Piece | What it does |
| --- | --- |
| MCP server `openrhen` | `your server's address plus /mcp, set by stamp-url.mjs`, streamable HTTP, OAuth (authorization code with PKCE). `oauth.scope` asks for exactly the scopes the served tools need plus the drive scopes (`AGENT_DRIVE_WRITE_SCOPES`: saves and settles apply, plan-map Inbox actions work); a test in `tools/cli/test/openclaw-plugin.test.ts` fails when the server's tools and this list drift. |
| Skills | `skills/openrhen/SKILL.md` is the short start skill (it points at `rhen_skill`, the live copy, records the contract version it was written for, and a test keeps that equal to `AGENT_CONTRACT_VERSION`, so repack the plugin when it is bumped): what OpenRhen owns versus agent memory, the "what now" flow, the write rules, a table saying which deeper skill to read first, and the hard limits. The deeper skills load only when read: `openrhen-concepts` (area, outcome, project, action, deliverable, commitment and the rest), `openrhen-writing`, `openrhen-deliverables`, `openrhen-sessions`, `openrhen-catch-up`, `openrhen-sleep`, `openrhen-inbox`. |
| Agent time | Once an agent-time token is set, OpenClaw's working time goes to OpenRhen' weekly Review line through `POST /api/agent-sessions` (ingest guide). It listens to model calls only (a metadata hook, no conversation access), cuts them into bursts with the portal's 30-minute idle gap, and sends start and end times, nothing else. |

## Install

Tested against OpenClaw 2026.10.7 (needs Node 24.22 or newer). OpenClaw reads a plugin's MCP server address from
a static manifest, so the plugin ships unstamped and you stamp your own server's address into it once, before
installing. An unstamped install cannot connect (its address ends in `.invalid`) and the plugin logs an error at start
naming the command to run.

1. Get the plugin: download `openrhen-openclaw-plugin-<version>.tgz` and its `.sha256` from the release page, then
   check them with `sha256sum -c openrhen-openclaw-plugin-<version>.tgz.sha256` (and, optionally,
   `gh attestation verify openrhen-openclaw-plugin-<version>.tgz --repo <owner>/<repo>` for the build provenance).
   From a source checkout, `node integrations/openclaw-plugin/pack.mjs` builds the same tarball.
2. Unpack it, stamp it with your server's address, and install the folder:

   ```sh
   tar -xzf openrhen-openclaw-plugin-<version>.tgz
   node openclaw-plugin/stamp-url.mjs https://your-server.example
   openclaw plugins install ./openclaw-plugin --accept-capabilities
   openclaw plugins inspect openrhen --runtime --json   # status "loaded", mcpServers.openrhen
   openclaw skills list | grep openrhen                 # "ready"
   ```

   OpenClaw warns that a local plugin is outside ClawHub review and asks you to accept its surface (one MCP
   server and eight skills). The address must be https (http is allowed for localhost only).
3. Restart the Gateway, open the Control UI, go to Plugins > OpenRhen > **Accounts**, and choose **Connect**.
   The OpenRhen consent page opens; sign in if asked, check the scopes it lists, and approve. The plugin page
   shows **Connected**. (Plugin-declared servers sign in from the plugin page; `openclaw mcp login` only knows
   servers under `mcp.servers`.)
4. Ask OpenClaw "what should I do now?". It should call `rhen_status` and answer with the engine's
   directive.

An `mcp.servers.openrhen` entry in OpenClaw's own config overrides the plugin's server of the same name, and an
older approval made that way holds every scope the server lists. If you set one up before, run
`openclaw mcp logout openrhen` and `openclaw mcp unset openrhen` first, and revoke the old `oauth-...` token
in OpenRhen Settings > Advanced > Agent tokens.

### Agent time (optional)

Without this step OpenRhen still counts OpenClaw's time whenever it calls the OpenRhen tools. A token adds
the conversations that never touch OpenRhen. It is a separate token because OpenClaw keeps the OAuth sign-in
inside its MCP client, where plugin code cannot reach it, and the server binds that sign-in to `/mcp` only.

1. Create the token with the OpenRhen CLI; it prints once. Keep it in your secret store. It can post session
   times and nothing else.

   ```sh
   rhen agent-token create --name openclaw --scopes agent-time
   ```

2. Put it in the plugin's settings: in the Control UI open the plugin's settings and fill **Agent-time token**
   (the field is concealed), or point it at an environment variable instead of a pasted value:

   ```sh
   openclaw config set plugins.entries.openrhen.config.agentTimeToken '{"source":"env","provider":"default","id":"OPENRHEN_AGENT_TIME_TOKEN"}' --strict-json
   ```

3. Restart the Gateway. After a conversation, the weekly Review shows the time within a minute or so. Until a
   token is set, or if the plugin was not stamped, it logs "agent time is not reported" once at start and sends
   nothing.

### Agent wake (optional)

OpenRhen can send the agent one scripted message, starting `[OpenRhen wake]`, when a check-in goes unanswered for
10 minutes, the pulse lapses, or the pulse goes unknown (only when no wake went out in the last 30 minutes), or the attention feed goes from nothing to something (a blocking data-health item or a due catch-up; at most one such wake an hour, none while the owner is asleep, and cancelled if the feed is read first); the agent then asks the owner in chat. It needs OpenClaw hooks and two server
variables: see agent wake setup.

## Update

Install the newer release the same way (unpack, stamp, `openclaw plugins install ./openclaw-plugin
--accept-capabilities --force`) and restart the Gateway. If the scope list changed, the next tool call that
needs a new scope gets `insufficient_scope`; reconnect from the plugin page to approve the new list. Update the
plugin and the server together: the skills use the server's current field names (the calendar-sharing fields
are `shareToCalendar`, `calendarShareEnabled` and `sharePrimaryEvents`; read `checkWithOwner` on a changeset
preview).

## Remove

`openclaw plugins uninstall openrhen`, then revoke its `oauth-...` token in OpenRhen Settings.
