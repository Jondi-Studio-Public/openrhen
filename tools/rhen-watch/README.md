# rhen-watch

A small Windows program that records which app was in front, when you were idle, and when the screen was locked or the machine slept, into a database on your own computer. It never sends anything anywhere and it has no network code (CI fails if a network crate is added). The design and its rules are in [Desktop activity agent](../../docs/architecture/desktop-activity-agent.md).

It is visible and stoppable: it runs in a console window you started, `rhen-watch stop` ends it, and `rhen-watch wipe --yes` deletes everything it recorded. It does not hide, autostart, or install a service.

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

This copies `rhen-watch.exe` (the command line) and `rhen-watchw.exe` (the same program with no console window) to `%LOCALAPPDATA%\Programs\rhen-watch`, makes the second one start at logon (the Startup tab of Task Manager lists it) and starts it. A tray icon shows while it runs; its menu has Pause or Resume, Open data folder and Quit. Pause is recorded as paused time and survives a restart, so a reboot does not silently start recording again. Errors go to `rhen-watch.log` in the data folder.

`rhen-watch.exe uninstall` stops it, removes start-at-logon and the program, and keeps your data; `uninstall --purge` deletes the data too. The build is unsigned, so Windows SmartScreen may warn on first run of a downloaded copy.

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

`rhen-watch stop` works within the same logon session only; from a remote desktop session use Ctrl+C in the console that is running it. `report` and `status` open the database read-only and are safe to run while the agent records. Closing the console window, logging off or shutting down all stop it cleanly.
