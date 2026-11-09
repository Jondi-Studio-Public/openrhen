# rhen-watch

A small Windows program that records which app was in front, when you were idle, and when the screen was locked or the machine slept, into a database on your own computer. It never sends anything anywhere and it has no network code (CI fails if a network crate is added). The design and its rules are in [Desktop activity agent](../../docs/architecture/desktop-activity-agent.md).

It is visible and stoppable: a tray icon shows whenever it runs, with Pause and Quit; `rhen-watch stop` ends it; `install` makes it start at logon (listed in Task Manager > Startup) and `uninstall` removes that. `rhen-watch wipe --yes` deletes everything it recorded. It never installs a service.

## Install

Build, then install for your user (no admin rights, no service):

```powershell
cd tools\rhen-watch
cargo build --release
.\target\release\rhen-watch.exe install
```

This copies `rhen-watch.exe` (the command line) and `rhen-watchw.exe` (the same program with no console window) to `%LOCALAPPDATA%\Programs\rhen-watch`, makes the second one start at logon (the Startup tab of Task Manager lists it) and starts it. A tray icon shows while it runs; its menu has Pause or Resume, Open settings (opens the data folder, where `config.toml` and `categories.toml` live), Open data folder and Quit. Pause is recorded as paused time and survives a restart, so a reboot does not silently start recording again. Errors go to `rhen-watch.log` in the data folder.

`rhen-watch.exe uninstall` stops it, removes start-at-logon and the program, and keeps your data; `uninstall --purge` deletes the data too (database, config, `rhen-watch.log` and its rotated copy, and the data folder when nothing else is in it). Run it from a copy outside the install folder to remove that folder as well: a program cannot delete itself. The build is unsigned, so Windows SmartScreen may warn on first run of a downloaded copy.

## Build and run

```powershell
cd tools\rhen-watch
cargo build --release
.\target\release\rhen-watch.exe run              # Ctrl+C to stop
.\target\release\rhen-watch.exe run --for 300    # stops itself after 5 minutes
.\target\release\rhen-watch.exe stop             # from another window
.\target\release\rhen-watch.exe report           # today
.\target\release\rhen-watch.exe report --day 2026-11-06
.\target\release\rhen-watch.exe report --from 2026-11-06 --to 2026-11-12   # several days, one after another
.\target\release\rhen-watch.exe export $env:USERPROFILE\Desktop\activity-copy.db   # safe copy while it runs; never overwrites
.\target\release\rhen-watch.exe status
.\target\release\rhen-watch.exe config init      # writes config.toml with every default
.\target\release\rhen-watch.exe config show      # every setting, its value, and whether it is the default
.\target\release\rhen-watch.exe config set derive.session_gap_minutes 8   # keeps the file's comments
.\target\release\rhen-watch.exe categories set foo.exe editor   # label an app (categories.toml)
.\target\release\rhen-watch.exe categories list --uncategorised # apps with no category yet
.\target\release\rhen-watch.exe wipe --yes     # database, config and log files; keeps the folder
```

Data lives in `%LOCALAPPDATA%\rhen-watch` (`activity.db`, `config.toml`, and `categories.toml` once you label an app). The folder is restricted to your user on first run.

## What it records by default

The executable name of the foreground app (for example `chrome.exe`) and its category, idle intervals (no input for 120 s), lock and unlock, logon and logoff, remote sessions, suspend and resume, display on and off, and AC or battery. It does not read window titles, URLs, screen text or images, and does not look at keyboard or mouse content: it asks Windows only how long ago the last input was, and from that keeps, per minute and per app, how long it watched and how much of that had input (in 5 s slots; never which keys, never what was typed). Titles and OCR are not built yet; turning them on in the config is an error.

Executable names alone can say a lot (a game, a medical app, a dating app). Treat `activity.db` as private and do not share it or a report without reading it first.

Retention is `permanent` by default; set `[retention] events = 90` (days) to delete older rows once a day (`rhen-watch config set retention.events 90`). `retention.input_buckets` does the same for the per-minute input tally.

## Categories and "your day at the PC"

`categories.toml` (beside `config.toml`) maps an exe to a category and a category to a group; the shipped defaults are built in and the file only holds overrides, so a missing file is fine. `rhen-watch categories init` writes every default into a commented file to edit; `categories set EXE CATEGORY` changes one entry and keeps your comments. A `[categories]` table in the old `config.toml` is no longer read: `run` and `report` stop with one line, and `categories init --from-config` prints the text to move. A mistake in `categories.toml` stops `report` with the file, line and reason, but the agent keeps recording with the built-in categories.

`report` starts with a derived section (first and last input of the day, input against time in front, the longest unbroken stretch, input blocks in `work` and `browser`, switch rate, and apps not categorised yet). It is worked out from the rows each time, marked derived, and never stored. The numbers it uses are the `[derive]` settings; browser time is its own group and is not counted as work. Synthetic input (remote tools, jigglers, scheduled tasks) counts as input.

## Games

While an executable from the built-in anti-cheat game list (or `extra_games` in the config) is in front, the agent records only that it was suppressed, not the name, and takes no idle samples. It still has a foreground hook registered, which does nothing but pass a window handle to a thread. Looking up the executable name uses a process list snapshot, not a handle on the game. This is best-effort. The agent starts at every logon, so before you play a game that is not on the list, either add its exe name to `extra_games` (`rhen-watch config set extra_games "mygame.exe"`, then restart the agent) or choose Pause in the tray, which survives a reboot, and Resume afterwards. [TESTING.md](TESTING.md) has a step to check your own games against the list.

## Manual check on a real machine (observation only)

CI proves the code builds and the rules work; only a real Windows session proves the hooks. [TESTING.md](TESTING.md) is the script: install from a normal prompt, a day-1 list where each step has the `report` line to expect, a kill test, an upgrade test, a week run, how to hand the data back, uninstall and purge checks, and the known limits. It never simulates input and never touches other apps. Do not do it with a game open.

`rhen-watch stop` works within the same logon session only; from a remote desktop session use Ctrl+C in the console that is running it. `report` and `status` open the database read-only and are safe to run while the agent records. Closing the console window, logging off or shutting down all stop it cleanly.
