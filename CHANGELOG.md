# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semantic versioning once 1.0 is released.

## [Unreleased]

### Added

First public release (0.1.0). The release PR gives this section its date and version.

- **Planning engine**: a deterministic library that turns areas, outcomes, projects, actions, deadlines, commitments, energy, places and equipment into one recommendation, a forecast of whether each project fits, and a plan for the day. The same inputs and clock give the same answer, with the reasoning attached.
- **Web portal**: Now, Day and Week, Plan, Inbox and Import, the weekly review, and a command palette (Ctrl K).
- **`rhen` command line and MCP server**: scripts and AI tools work the same data through the same validated commands, with changes recorded in an undo log you can review and reverse.
- **Outbound proxy and connection host**: the one place third-party credentials live; connections are add-on packages ([writing a connection](docs/architecture/writing-a-connection.md)).
- **Archive, cancel and restore**: one Archive or Cancel button per plan item with a ten-second Undo, a Review > Closed page that shows who closed each item and why and restores it, and a Now and Day line for what an agent closed in the last 24 hours.
- **Self-hosting**: PostgreSQL persistence with one baseline migration, a bundled database, verified daily backups (off until you turn them on), and Docker images for linux/amd64 and linux/arm64 that `docker compose up` builds from source (published images are planned). Start with `docker compose run --rm setup` and `docker compose up -d`.

### Fixed

- **Calendar cancellations**: when a connected calendar or feed cancels an event, or an event disappears from it, OpenRhen now cancels the commitment (with its steps and safe prep actions) instead of deleting it. It shows in Review > Closed with the reason "Removed at source" and can be restored there; an event that comes back reopens it, and one you cancelled yourself is never reopened by an import. The close brake counts these cancellations, and an import preview says "Still cancelled by you" for an update to a commitment you cancelled.
- **Ending a recurring commitment**: ending the rule (or a calendar feed ending its series) now cancels its future dates (with their steps and the prep actions that are safe to cancel) instead of deleting them. They show in Review > Closed with the reason "Recurrence ended" and who ended it, the planner never prunes or reopens them, and setting the rule active again brings back exactly the dates that end closed (with their steps) while a date you cancelled yourself stays cancelled. One date can also be restored on its own, and the planner keeps it. An agent's save can no longer delete deliverable steps: leaving a step out is refused with the exact cancel or archive call, and your own saves are unchanged.
- **Closing a finished step**: archiving a done deliverable step no longer breaks the state read with a validation error. The step comes back as archived, is left out of the deliverable's progress count and never holds up completion, and re-saving the deliverable keeps a closed step as it is without letting a save close one.

### Known limits

- Pre-1.0: screens, commands and schemas can change between minor versions, and this file says when.
- Built for one person per installation; there are no user accounts or sharing.
- Owner sign-in is off by default and is only safe on `127.0.0.1`. Lock the API down before exposing it ([locking down](docs/operations/locking-down.md)).
- No telemetry, and no hosted service: you run it yourself.
