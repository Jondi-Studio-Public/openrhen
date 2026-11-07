# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semantic versioning once 1.0 is released.

## [Unreleased]

### Added

- **Now offer log records what was shown**: the open Now page (when it is visible) and the handheld (when its screen changes) now add a `shown` row naming what Now resolved to, and the engine primary it covered when something else (a commitment, sleep, a routine step) was on top. `shown` is a lower bound on what you saw: background tabs, several surfaces and polling can miss or repeat exposure, and an identical repeat within five minutes is dropped. No screen changes.
- **Now offer log (storage only)**: a new append-only table (migration 0147) records what Now offered whenever the primary or top five changes, and what you then did (started, skipped, did not start, blocked, snoozed, checked in; a snooze is logged for any save that moves an action later, so it is a lower-bound signal), with the rank of what you chose. Nothing reads it yet and the planner cannot see it. It is included in backups, which move to format 21; a format 20 backup still restores, with the log empty.
- **Activity store (ingest)**: one append-only table for everything that is not the plan (desktop activity, browser history, plays, messages, sleep, weather, phone shortcuts), with `POST /api/activity-events` (a batch, or a single event from a phone shortcut), a read-back route, per-source content gate and retention, undo-import and purge-by-source. New scopes `write:activity-event` and `read:activity-event` (the read scope exposes stored text over a token) and the token preset `activity-capture`. Migration 0148 adds three tables the planner cannot see; backups move to format 23 (formats 22, 21 and 20 still restore, with the activity tables empty where they predate them). The activity events are written to their own streamed file beside the JSON backup (`<backup>.activity-events.ndjson`, with its row count and SHA-256 in the JSON), straight from a database cursor, so a backup and a restore use flat memory at any size (2,000,000 rows tested); keep the two files together. `db:restore:verify` checks the file's checksum and row count, and reads the restored table back against them. Retention can be saved per source but the automatic purge does not run yet, and the settings response and summary say so.
- **Passwords and keys, and video lengths for watch history**: a new **Settings > Passwords and keys** page takes a YouTube Data API key, saved encrypted (AES-256-GCM under a master key, write-only, never shown back and unreachable by any agent route or tool), and Review then looks up each watched video's length through the outbound proxy (new `youtube_data` connection, `video_metadata` capability) to narrow the time estimate. Adds migration 0146 (`app_secrets` and `youtube_quota_use`, both left out of backups, so no backup format change) and the environment variable `OPENRHEN_SECRETS_KEY` (32 random bytes, base64, portal only; `init-env` makes one). Saving a key needs `OPENRHEN_OWNER_AUTH=require` and the master key; the page says exactly what to set. The architecture rule "secrets stay out of the portal" now has this one deliberate exception.
- **YouTube watch history in Review**: import a Google Takeout history (the zip or its `watch-history.json`, JSON format) and Review shows videos watched per day and per hour for the last 30 days in your time zone, with a time estimate shown as a range that leans high. Imports are idempotent and can be deleted one at a time; ads, posts and YouTube Music are kept but not counted. The rows sit in new tables the planner cannot see (migration 0145) and are included in backups, which move to format 20 (a format 19 backup is no longer restored by this build). Video lengths and a YouTube API key come later.
- **The agent is woken when attention items appear**: when a blocking data-health item or a due catch-up shows up after the feed was empty, the worker sends the agent one `[OpenRhen wake]` message (at most one an hour, none while the owner is asleep, cancelled if the feed is read first), so it no longer waits for someone to look. Adds migration 0144 (one more `agent_wakes` event); no new tool text.
- **I'm free**: say you are free of a running commitment (the Now button, `rhen free <id>`, or an agent saving `free: true`) and the planner recommends your next task at once, without ending or moving the commitment. Undo restores it. An agent's request on a commitment shared with the family calendar waits for your confirmation. Adds the nullable column `commitments.freed_from` (migration 0143, additive).

### Changed

- **Watch history panel**: the delete-import button is disabled while its request is pending, results are announced through an always-present status region, and a window with no watches says how many are held ("12 watches held, none in the last 30 days"). The time estimate shows its range plainly once video lengths are known.
- **Agents reading status no longer count as the owner seeing a check-in**: `status` peeks at the open check-in without marking it shown (so it cannot push the pulse toward a lapse), and its attention count now includes an open check-in and a due catch-up, matching `rhen_attention`.
- **Quicker portal presses**: large JSON answers are gzipped for clients that accept it, commands go to the server one at a time in press order, and Start, Refresh the plan and "Woke at" disable only themselves while their own command runs instead of every button on the page.

## [0.1.0] - 2026-11-05

First public release.

### Added

- **Planning engine**: a deterministic library that turns areas, outcomes, projects, actions, deadlines, commitments, energy, places and equipment into one recommendation, a forecast of whether each project fits, and a plan for the day. The same inputs and clock give the same answer, with the reasoning attached.
- **Web portal**: Now, Day and Week, Plan, Inbox and Import, the weekly review, and a command palette (Ctrl K).
- **`rhen` command line and MCP server**: scripts and AI tools work the same data through the same validated commands, with changes recorded in an undo log you can review and reverse.
- **Outbound proxy and connection host**: the one place third-party credentials live; connections are add-on packages ([writing a connection](docs/architecture/writing-a-connection.md)).
- **Archive, cancel and restore**: one Archive or Cancel button per plan item with a ten-second Undo, a Review > Closed page that shows who closed each item and why and restores it, and a Now and Day line for what an agent closed in the last 24 hours.
- **Self-hosting**: PostgreSQL persistence with one baseline migration, a bundled database, verified daily backups (off until you turn them on), and Docker images for linux/amd64 and linux/arm64 that `docker compose up` builds from source (published images are planned). Start with `docker compose run --rm setup` and `docker compose up -d`.
- **OpenClaw plugin**: attached to the release as `openrhen-openclaw-plugin-<version>.tgz` with a `.sha256` and a build-provenance attestation ([install](integrations/openclaw-plugin/README.md)). The plugin has its own version number.

### Fixed

- **Calendar cancellations**: when a connected calendar or feed cancels an event, or an event disappears from it, OpenRhen now cancels the commitment (with its steps and safe prep actions) instead of deleting it. It shows in Review > Closed with the reason "Removed at source" and can be restored there; an event that comes back reopens it, and one you cancelled yourself is never reopened by an import. The close brake counts these cancellations, and an import preview says "Still cancelled by you" for an update to a commitment you cancelled.
- **Ending a recurring commitment**: ending the rule (or a calendar feed ending its series) now cancels its future dates (with their steps and the prep actions that are safe to cancel) instead of deleting them. They show in Review > Closed with the reason "Recurrence ended" and who ended it, the planner never prunes or reopens them, and setting the rule active again brings back exactly the dates that end closed (with their steps) while a date you cancelled yourself stays cancelled. One date can also be restored on its own, and the planner keeps it. An agent's save can no longer delete deliverable steps: leaving a step out is refused with the exact cancel or archive call, and your own saves are unchanged.
- **Closing a finished step**: archiving a done deliverable step no longer breaks the state read with a validation error. The step comes back as archived, is left out of the deliverable's progress count and never holds up completion, and re-saving the deliverable keeps a closed step as it is without letting a save close one.

### Known limits

- Pre-1.0: screens, commands and schemas can change between minor versions, and this file says when.
- Built for one person per installation; there are no user accounts or sharing.
- Owner sign-in is off by default and is only safe on `127.0.0.1`. Lock the API down before exposing it ([locking down](docs/operations/locking-down.md)).
- No telemetry, and no hosted service: you run it yourself.
