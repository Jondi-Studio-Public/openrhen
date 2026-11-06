# Self-hosting

You need this when you are installing OpenRhen, or moving it to another machine.

Run OpenRhen on your own machine with Docker, or from source.

## Requirements

- Docker Engine with Compose v2, or Docker Desktop on macOS or Windows.
- At least 8 GB of memory available to Docker while images build (a smaller VM runs out during `pnpm install`). On Docker Desktop set it under Settings > Resources > Memory.
- About 20 GB of free disk for image builds; a full disk can corrupt Docker's image store mid-build.
- An x86-64 or arm64 machine (Apple Silicon and Raspberry Pi 64-bit are supported).
- git. Nothing else is needed for the Docker path: no Node and no pnpm.

Supported: the Docker path on Linux, macOS and Windows with Docker Desktop. Running from source works on Linux, macOS and WSL, and on a best-effort basis on native Windows.

## Quick start

These commands work unchanged in any common shell, on Linux, macOS and Windows:

```text
git clone https://github.com/Jondi-Studio-Public/openrhen.git && cd openrhen
docker compose run --rm setup
docker compose up -d
```

Open `http://localhost:8787`.

`setup` writes `.env` from `.env.example` with generated secrets and never prints one; running it again changes nothing you set. The portal listens on this machine only (`PORTAL_HOST_IP=127.0.0.1`). Set `APP_TIMEZONE` in `.env` to your IANA timezone if `setup` asks you to. Compose may warn that some variables (for example `DATABASE_URL`) are unset; those warnings are harmless. A new install starts with an empty plan; the [user guide](../product/user-guide.md) covers first use.

`docker compose up` builds the images from your checkout the first time (published multi-arch images under `ghcr.io/jondi-studio-public/openrhen-*` are planned; once they exist, `up` will pull them). Run `docker compose up -d --build` to rebuild after changing the source. Set `IMAGE_PREFIX` and `IMAGE_TAG` in `.env` to use images from elsewhere.

Check the stack with `docker compose ps` and open `http://localhost:8787/api/health/engine`; expect `"reachable": true`. To run beside another Compose project of the same name, set `COMPOSE_PROJECT_NAME` in `.env` and change `PORTAL_PORT` and `POSTGRES_HOST_PORT`.

To prove the whole path on a Docker host, `node scripts/selfhost/smoke.mjs` copies the committed tree, runs these steps in a throwaway project and tears it down. It refuses any Docker endpoint that is not local, so it cannot touch a remote server.

## Profiles

`.env` sets `COMPOSE_PROFILES=app,bundled-db`.

- `app`: the core services (planning service, outbound proxy, migrate, backup, worker, portal).
- `bundled-db`: a Postgres 17 container with a named volume, published on `127.0.0.1:${POSTGRES_HOST_PORT:-55432}` only. Remove it from `COMPOSE_PROFILES` and set `DATABASE_URL` to use your own database.
- `setup`: the one-shot first-run command above.

## Exposing it beyond this machine

Owner sign-in is off by default, which is only safe on `127.0.0.1`. Before setting `PORTAL_HOST_IP` to a LAN address or `0.0.0.0`, lock down:

```text
docker compose run --rm setup node scripts/setup/init-env.mjs --docker --lockdown
```

Without Docker, run `node scripts/setup/init-env.mjs --lockdown`. Then set `OPENRHEN_OWNER_AUTH=require` and follow [Locking down the API](locking-down.md). Recreate the portal after editing `.env`: `docker compose up -d`.

If you put the portal behind a reverse proxy, terminate TLS there and set `PORTAL_ALLOWED_HOSTS` to the host names it serves. Several browser features (such as the secure-context cryptography the portal uses) require https once you leave localhost.

## Upgrading

```text
git pull
docker compose up -d --build
```

(Once published images exist, `docker compose pull` then `docker compose up -d` will replace the build.) The `migrate` service runs first. On the bundled database it applies pending migrations after writing a `pg_dump` to `var/backups/pre-migrate` (the newest five are kept), and it stops if the dump fails. Upgrades roll forward; going back past a migration means restoring that dump.

## Backups

The `backup` service is on by default; there is no switch. Daily at `BACKUP_TIME` (default 03:30) it writes a backup, restores it into a scratch database to prove it, and keeps the newest 14 in `var/backups` (change the folder with `BACKUP_HOST_DIR`). It is a host folder, not a Docker volume, so `docker compose down -v` cannot wipe it. Setup writes `POSTGRES_ADMIN_URL`, which the restore check needs; without it the backup still runs and the Data check says it was not restore-tested.

With nothing else set, backups stay on this machine, and the Data check says "Backups don't leave this machine", because they would go with the disk. To fix that, set in `.env`:

- `BACKUP_COPY_DIR` as a host folder on another machine or disk (a mounted NAS share) containing a `.openrhen-backup-target` marker file. The run fails if the marker is missing (the share is not mounted) or there is less than 5 GB free.
- `BACKUP_COPY=off` instead, to accept local-only backups on purpose and silence that finding.
- `BACKUP_PING_URL`, a healthchecks.io-style URL that alerts when a backup is missed. Blank means no monitor.

Back up now with `docker compose run --rm backup corepack pnpm db:backup`. Retention, restore and recovery are in [Database and backups](database-and-backups.md).

## Calendar feed and agent wake

Both are optional; leave them out and nothing changes.

- **Calendar feed** (`CALENDAR_FEED_URL`): lets OpenRhen read events from a calendar you cannot sign in to (a roster, a school or club calendar) through its private iCal address, which only the outbound proxy sees. The address is the secret, so treat it like a password. It must be https. Google Calendar: Settings, pick the calendar, Integrate calendar, copy "Secret address in iCal format". Outlook.com: Settings, Calendar, Shared calendars, Publish a calendar, choose "Can view all details", copy the ICS link. iCloud: Calendar app, share the calendar as a public calendar and copy the link with `webcal://` changed to `https://`. Put it in `.env`; recreate the stack with `docker compose up -d`.
- **Agent wake** (`OPENCLAW_HOOKS_URL`, `OPENCLAW_HOOKS_TOKEN`): lets the engine worker message your OpenClaw agent when a check-in goes unanswered, the pulse lapses or goes unknown, or the attention feed goes from nothing to something (at most one of that last kind an hour, and one per episode: if it goes unsent, no other follows until the feed has been empty). Turn hooks on in OpenClaw (`hooks.enabled`, and a new random `hooks.token`), set the URL to the gateway address the worker can reach (https, or http to loopback or a private VPN address) and the token to the same `hooks.token`. With either empty the sender does nothing. To land the wake in your main chat session, also set `OPENCLAW_HOOKS_AGENT_ID`, `OPENCLAW_HOOKS_CHANNEL`, `OPENCLAW_HOOKS_ACCOUNT_ID`, `OPENCLAW_HOOKS_TO` (the chat id) and `OPENCLAW_HOOKS_SESSION_KEY` (for example `agent:<agent>:main`); the sender then asks for a persistent session. Without them OpenClaw starts an isolated session that cannot see the chat.

  Make the token with `openssl rand -hex 32` (or, in PowerShell, `[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')`) and use it for nothing else. Before relying on it, send the request OpenRhen sends and check that a message reaches your chat (the URL has no `/hooks/agent` on the end; add it here):

  ```text
  curl -X POST "<url>/hooks/agent" -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"message":"[OpenRhen wake] Test. Message the owner once: Still on the test task?","name":"rhen"}'
  ```

  Later wakes show their status in the `agent_wakes` table.

## Changing settings on a remote server

If the stack runs on another machine, edit `.env` there, or keep the real file on your workstation and copy it over. Create the target as private first, because `scp` onto an existing file keeps that file's mode:

```text
ssh <server> "install -m 600 /dev/null <dir>/.env.new"
scp .env <server>:<dir>/.env.new
ssh <server> "mv <dir>/.env.new <dir>/.env && cd <dir> && docker compose up -d"
```

Write the file with LF line ends (Compose keeps a trailing CR in every value otherwise). With a secrets manager, fill a template of references into a temporary file, copy it as above and delete the temporary file straight afterwards; drop comment lines first, because some fillers resolve references inside comments. Never commit `.env`.

## Running from source

For development, use the bundled database from Docker and the apps on your machine. You need Node.js (CI and the Docker images use 24; no `engines` field pins a minimum) and pnpm 11 through corepack (if `corepack pnpm` fails with `Cannot find matching keyid`, run `npm install -g corepack@latest`).

```text
node scripts/setup/init-env.mjs --mode source
docker compose up -d postgres
corepack pnpm install
corepack pnpm db:migrate
corepack pnpm dev
```

`--mode source` points the database URLs at `127.0.0.1:55432`. `corepack pnpm dev` starts the portal and prints its address; `corepack pnpm dev:all` also starts the planning service and worker. Useful checks: `corepack pnpm check` (format, lint, structure, docs, script tests), `typecheck`, `test`, and `test:integration`, which uses a throwaway Postgres and refuses anything that is not loopback.

The CLI talks to `http://localhost:8787` by default, but `corepack pnpm dev` serves the portal on `http://localhost:5173`, so run `OPENRHEN_URL=http://localhost:5173 corepack pnpm cli status` (on Windows, set `$env:OPENRHEN_URL="http://localhost:5173"` first). `corepack pnpm cli` runs the CLI from source; `corepack pnpm --filter @openrhen/cli build` makes the standalone `tools/cli/dist/rhen.mjs`.

To try OpenRhen with a believable week of invented data instead of an empty plan, run `corepack pnpm dev:all` in one terminal and `corepack pnpm seed:demo` in another. It takes a few minutes, refuses any portal or database that is not on this machine, and is safe to re-run. Skip it to start from the empty setup screen.

**A `DATABASE_URL` already set in your shell wins over `.env`.** If a command talks to the wrong database, unset it in that shell.

## Troubleshooting

- `docker compose up` starts nothing and shows no error: there is no `.env`. Every service is profile-gated and `COMPOSE_PROFILES` comes from `.env`, so run `docker compose run --rm setup` first.
- Postgres exits with "superuser password is not specified": setup was skipped. Run `docker compose run --rm setup`, then `docker compose up -d`.
- `outbound-proxy` exits complaining about its token: same cause; `.env` still has the placeholder.
- Photo uploads fail with EACCES: `var/photos` is owned by the wrong user. `docker compose run --rm setup` fixes ownership.
- "port is already allocated": something else holds 8787 or 55432. Set `PORTAL_PORT` or `POSTGRES_HOST_PORT` in `.env` and run `docker compose up -d`.
- Logs: `docker compose logs --tail 100 <service>`.
- Which MCP tools fail, and how often an agent retries: the portal writes one log line per request, and a `POST /mcp` line also carries `mcpMethod`, and for a tool call `mcpTool` (a tool name, or `unknown`), `mcpOutcome` (`ok`, `tool_error` or `protocol_error`; a failed tool call is still HTTP 200), `toolErrorCode` (the error code, or a JSON-RPC number), `mcpRetryable`, `argBytes`, `resultBytes` and `idTag`. None of them holds anything the agent sent or received: only closed names, byte lengths, and `idTag`, a short salted hash of a command id the agent chose, so repeats of one id count as retries (a portal restart resets it). To summarise, pipe the logs through the digest. The same command works in PowerShell and bash: `docker compose logs --no-log-prefix portal | node scripts/ops/mcp-call-digest.mjs`. It also reads a saved file (`node scripts/ops/mcp-call-digest.mjs portal.log`) and `--json` prints the raw figures.
