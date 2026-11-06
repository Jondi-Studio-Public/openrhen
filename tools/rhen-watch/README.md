# rhen-watch

A small Windows program that records which app was in front, when you were idle, and when the screen was locked or the machine slept, into a database on your own computer. It never sends anything anywhere and it has no network code (CI fails if a network crate is added). The design and its rules are in [Desktop activity agent](../../docs/architecture/desktop-activity-agent.md).

It is visible and stoppable: it runs in a console window you started, `rhen-watch stop` ends it, and `rhen-watch wipe --yes` deletes everything it recorded. It does not hide, autostart, or install a service.

## Build and run

```powershell
cd tools\rhen-watch
cargo build --release
.\target\release\rhen-watch.exe run              # Ctrl+C to stop
.\target\release\rhen-watch.exe run --for 300    # stops itself after 5 minutes
.\target\release\rhen-watch.exe stop             # from another window
.\target\release\rhen-watch.exe report           # today
.\target\release\rhen-watch.exe report --day 2026-11-06
.\target\release\rhen-watch.exe status
.\target\release\rhen-watch.exe config init      # writes config.toml with every default
.\target\release\rhen-watch.exe wipe --yes
```

Data lives in `%LOCALAPPDATA%\rhen-watch` (`activity.db`, `config.toml`). The folder is restricted to your user on first run.

## What it records by default

The executable name of the foreground app (for example `chrome.exe`) and its category, idle intervals (no input for 120 s), lock and unlock, logon and logoff, remote sessions, suspend and resume, display on and off, and AC or battery. It does not read window titles, URLs, screen text or images, and does not look at keyboard or mouse content: it asks Windows only how long ago the last input was. Titles and OCR are not built yet; turning them on in the config is an error.

Executable names alone can say a lot (a game, a medical app, a dating app). Treat `activity.db` as private and do not share it or a report without reading it first.

Retention is `permanent` by default; set `[retention] events = 90` (days) to delete older rows once a day.

## Games

While an executable from the built-in anti-cheat game list (or `extra_games` in the config) is in front, the agent records only that it was suppressed, not the name, and takes no idle samples. It still has a foreground hook registered, which does nothing but pass a window handle to a thread. Looking up the executable name uses a process list snapshot, not a handle on the game. This is best-effort: if you play a game with kernel anti-cheat, stop the agent first (`rhen-watch stop`) until it has been checked against that game.

## Manual check on a real machine (observation only)

CI proves the code builds and the rules work; only a real Windows session proves the hooks. Run `run --for 300`, then in that time: switch between a few apps, press Win+L and unlock, let the display sleep (or use the power button's sleep), and leave the keyboard alone for over two minutes. Then run `report` and check that: apps and categories look right, the lock and sleep show as their own lines and not as app time, idle is listed, there is a `Gaps` section only if you slept the machine, and `Agent cost` shows well under 1% CPU and under 50 MB. Do not do this with a game open. The tool never types, clicks, focuses or closes anything.
