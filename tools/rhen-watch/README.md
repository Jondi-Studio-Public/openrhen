# rhen-watch

A small Windows and macOS program that records which app was in front, when you were idle, and when the screen was locked or the machine slept, into a database on your own computer. It never sends anything anywhere and it has no network code (CI fails if a network crate, a network API call or a networking feature is added). The design and its rules are in [Desktop activity agent](../../docs/architecture/desktop-activity-agent.md).

It is visible and stoppable: a tray icon shows whenever it runs, with Pause and Quit; `rhen-watch stop` ends it; `install` makes it start at logon and come back by itself if it crashes or is killed, and `uninstall` removes that. `rhen-watch wipe --yes` deletes everything it recorded. It never installs a service.

## Install

From a release (no build, no admin rights). In PowerShell, replace `<version>` with the number on the [Releases page](https://github.com/Jondi-Studio-Public/openrhen/releases) (tags are `rhen-watch-v<version>`):

```powershell
irm https://github.com/Jondi-Studio-Public/openrhen/releases/download/rhen-watch-v<version>/install.ps1 | iex
```

It downloads `rhen-watch-<version>-windows-x86_64.zip` and `SHA256SUMS` from that release over https, stops if the hash does not match, unpacks to a temporary folder, runs `rhen-watch.exe install` and deletes the folder. To do it by hand, download the zip and `SHA256SUMS` from the release, check `(Get-FileHash .\the.zip).Hash` against its line, unzip and run `.\rhen-watch.exe install`. The releases are unsigned, so SmartScreen may warn about a zip downloaded in a browser. Running the one-liner again upgrades.

Or build, then install for your user (no admin rights, no service):

```powershell
cd tools\rhen-watch
cargo build --release
.\target\release\rhen-watch.exe install
```

This copies `rhen-watch.exe` (the command line) and `rhen-watchw.exe` (the same program with no console window) to `%LOCALAPPDATA%\Programs\rhen-watch`, registers two per-user Scheduled Tasks (no admin rights): `rhen-watch` starts the second one at logon and `rhen-watch-keepalive` checks every minute and starts it again if it died without being asked to stop (a crash or a kill). `install` starts it through the first task. If the tasks cannot be registered (policy, `schtasks.exe` missing), `install` says why in `rhen-watch.log`, falls back to a Start-at-logon entry (listed in Task Manager > Startup) and `status` prints `restart on crash: no (reason)`; with the tasks it prints `restart on crash: yes (scheduled task)`. `install` also puts the install folder on your user `PATH` (the `Path` value under `HKCU\Environment`, no admin rights; added once, other entries and the value's type untouched, and Windows is told so new shells see it), so after opening a new PowerShell `rhen-watch status` works without the full path; `uninstall` removes exactly that entry. It also adds a Start menu entry, `rhen-watch`, that opens the settings window (it warns and carries on if the Start menu cannot be written). A tray icon shows while it runs: a green disc while recording, a grey one while paused, an amber one (and one balloon, which takes no focus) when writes start failing. If Windows will not take the icon at logon, the agent retries every 2 seconds. The menu has Pause or Resume, Open settings (the settings window), Open data folder and Quit. Pause is recorded as paused time and survives a restart, so a reboot does not silently start recording again. Errors go to `rhen-watch.log` in the data folder. Run `install` from a normal PowerShell, not an administrator one: it refuses otherwise, because an agent started as administrator cannot be stopped from a normal prompt. It also checks `config.toml` first and stops with the error, before it copies anything or sets start at logon. If a settings file is bad at logon, `rhen-watchw.exe` shows the error in a message box (it does not take focus), and so does a `run` that stops later, for example after 60 failed writes in a row (not a duplicate start), and `status` and `config show` print `settings: ERROR ...`.

`rhen-watch.exe uninstall` stops it, removes the task, start-at-logon and the program, and keeps your data; `uninstall --purge` deletes the data too (database, config, `rhen-watch.log` and its rotated copy, and the data folder when nothing else is in it). Run it from a copy outside the install folder to remove that folder as well: a program cannot delete itself. The build is unsigned, so Windows SmartScreen may warn on first run of a downloaded copy.

### The settings window

Open `rhen-watch` from the Start menu, the tray icon's Open settings, or `rhen-watchw.exe app`. It is a separate program from the recorder, so closing it never stops recording, and a second launch brings the open window to the front. It has three tabs:

- **Overview**: whether it is recording, paused, has problems or is not running (and why it did not start), Pause or Resume, Stop recording, Start recording, today's report, and Open data folder. If nothing is running, opening the window does not start anything; Start recording does, through the scheduled task when there is one. An agent started by a version before 0.2.0 shows as running but cannot be controlled from the window; quit it from its tray icon once.
- **Apps**: apps with no category yet, longest in front first. Pick one, choose or type a category, press Set: it writes your `categories.toml` the way `categories set` does. The built-in app table is not touched. It takes effect when recording restarts (Restart recording).
- **Settings**: Start with Windows (the two tasks, or the Run entry when they cannot be registered; unticking removes both, so it also turns off restart after a crash, and rhen-watch stays closed after you log off), Keep data (Forever or a number of days; a shorter choice says how many recorded events it would delete and asks first) and the idle threshold. Apply checks everything first and refuses to write if `config.toml` is already broken. These are read when the agent starts, so Apply offers Restart recording.

The window talks to the agent only through its hidden window (pause and resume), the stop event (stop and restart), the run lock and a small `state.txt` the agent keeps in the data folder. It has no network code, and there is no server setting in it: rhen-watch has no uploader, so there is nothing to connect. `install` and `uninstall` close an open window first and change nothing if it will not close. `rhen-watchw.exe app --smoke` builds the window without showing it and checks its controls (CI uses it).

### macOS

macOS 13 or later, arm64 or x86_64, from the same release (no admin rights; it refuses `sudo`). In Terminal:

```sh
curl -fsSL https://github.com/Jondi-Studio-Public/openrhen/releases/download/rhen-watch-v<version>/install.sh | sh
```

It downloads `rhen-watch-<version>-macos-universal.tar.gz` and `SHA256SUMS` over https, stops if the hash does not match, unpacks to a temporary folder and runs `rhen-watch install`, which builds `~/Applications/rhen-watch.app`, signs that copy ad hoc (the release is not notarised), writes a LaunchAgent for your user (`~/Library/LaunchAgents/org.openrhen.rhen-watch.plist`, listed in System Settings under Login Items, Allow in the Background) and starts it. launchd restarts it after a crash, never after `stop` or Quit. An icon in the menu bar shows while it runs, with Pause or Resume, Open data folder and Quit; if it cannot start at login it keeps the icon up with the reason instead of vanishing. It needs no privacy permission (no Accessibility, Screen Recording or Input Monitoring). The data folder is `~/Library/Application Support/rhen-watch`. The app is recorded by bundle id (for example `com.example.editor`), which `categories.toml` accepts next to `.exe` names. There is no built-in table for macOS: an app goes in the category it declares for itself (its `LSApplicationCategoryType`, so `public.app-category.developer-tools` becomes `developer-tools`, and every kind of game is `games`), an entry in `categories.toml` overrides that, and an app that declares nothing is uncategorised until you set it (`categories list --uncategorised` lists them). Stop, report and uninstall with `~/Applications/rhen-watch.app/Contents/MacOS/rhen-watch stop|report|uninstall [--purge]`.

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

The rest of `report` lists paused time and time the agent was off as their own lines; both count as known time. It also counts instant events (logon, power source, start and stop) and prints `Clock jumps backwards` when the wall clock stepped back. A clean stop is recorded as `off` (this can also be a machine shutdown, which asks the agent for a clean stop); a panic writes no stop row; a crash, kill or power cut is recorded as `unknown`, and the next `run` says the previous run ended without a clean stop. Each `agent/start` row stores the settings of that run (idle threshold, collectors, retention, how many extra games are set (a count, never their names), where the categories came from).

## Games

While an executable from the built-in anti-cheat game list (or `extra_games` in the config) is in front, the agent records only that it was suppressed, not the name, and takes no idle samples (and idle never backdates into the game afterwards). Each `extra_games` entry must be a bare file name ending in `.exe` (case and surrounding spaces are ignored); a path or a name without `.exe` is refused by `config set` and when the file loads. It still has a foreground hook registered, which does nothing but pass a window handle to a thread. Looking up the executable name uses a process list snapshot, not a handle on the game. This is best-effort. The agent starts at every logon, so before you play a game that is not on the list, either add its exe name to `extra_games` (`rhen-watch config set extra_games "mygame.exe"`, then restart the agent) or choose Pause in the tray, which survives a reboot, and Resume afterwards. [TESTING.md](TESTING.md) has a step to check your own games against the list.

## Manual check on a real machine (observation only)

CI proves the code builds and the rules work; only a real Windows session proves the hooks. [TESTING.md](TESTING.md) is the script: install from a normal prompt, a day-1 list where each step has the `report` line to expect, a kill test, an upgrade test, a week run, how to hand the data back, uninstall and purge checks, and the known limits. It never simulates input and never touches other apps. Do not do it with a game open.

`rhen-watch stop` works within the same logon session only; from a remote desktop session use Ctrl+C in the console that is running it. `report` and `status` open the database read-only (they never migrate it) and are safe to run while the agent records; `status` prints the schema version. A failed metrics write is logged once and retried every second, and a failed daily purge every minute, each with a short wait on a locked database; neither ends the agent. If the no-console build cannot start, or stops, it shows the error in a message box that closes itself after a minute, after the run lock is free, so a new agent can start; the error is also in `rhen-watch.log`. If `stop` says an agent is running as administrator, use the tray Quit or an elevated prompt. Closing the console window, logging off or shutting down all stop it cleanly.

**Restart on crash.** Task Scheduler's own "restart on failure" setting does not relaunch a process that dies after it started (a real Windows runner showed it), so a second task, `rhen-watch-keepalive`, runs `rhen-watchw.exe run --keepalive` every minute. It does nothing if an agent is running. A requested stop (`rhen-watch stop`, tray Quit, Ctrl+C, closing the console, logoff, shutdown, `run --for`) writes `stopped-by-user.txt` in the data folder, and the keep-alive leaves the agent stopped until the next logon, `install` or a manual `run` (`stop` writes the marker even when no agent is running); a crash, a panic or a kill writes none and the agent is back within about a minute. If a start is refused for a bad configuration (a leftover `[categories]` table), the reason goes to `not-starting.txt`, `status` prints `not starting: <reason>`, and the keep-alive waits until `config.toml` or `categories.toml` is edited (or 15 minutes pass, for a cause outside the settings). The gap shows in `report` as `agent not running`.

**Manual check as a standard user.** CI cannot prove the no-admin claim because the hosted Windows runner is an administrator. On a real machine, sign in as a standard (non-admin) user, run `rhen-watch.exe install` from a normal prompt, and confirm `status` says `restart on crash: yes (scheduled task)` and `schtasks /Query /TN rhen-watch` lists the task. Then `Stop-Process -Name rhen-watchw -Force`, wait about 90 seconds and confirm `status` says `agent: running`; `rhen-watch.exe stop` must leave it stopped. If `status` says `no (...)`, the reason is also in `rhen-watch.log`.
