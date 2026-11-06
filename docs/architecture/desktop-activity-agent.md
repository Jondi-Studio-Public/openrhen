# Desktop activity agent (rhen-watch)

Status: design for phase 1, Windows only. Owns: what the device agent in `tools/rhen-watch` captures, stores and shows, and the rules that bound it. The server half (ingest endpoint, tables, retention setting) is a later change and is described only where phase 1 must not preclude it.

## What it is

`rhen-watch` is a small native program (Rust, one binary, no installer) that records what happened on a computer so later features can compare the plan with the day. In phase 1 it is local-only: it writes an append-only SQLite file on the machine and has a command-line report. It sends nothing anywhere and has no network code.

## Rules

- **Observation only.** It reads. It never simulates input, steals focus, restores or closes a window, or opens a handle on another process (executable names come from a process list snapshot).
- **Unknown stays unknown.** A collector that is off or blocked writes nothing or an explicit `unknown` interval. A gap is never read as idle.
- **Opt-in for anything sensitive.** Collectors that read window titles, URLs, screen text (OCR) or images are OFF by default and must be switched on one by one in the config file. Phase 1 on-by-default collectors record only the executable name, idle time, session lock and display and power state.
- **Raw, not derived.** Rows are observed events. Labels such as "working" or "in a meeting" are not computed here.
- **Games are left alone, best effort.** The executable name is read from a process list snapshot, so no handle is opened on the game. While a denylisted executable is in front the agent writes one `suppressed` interval (without the name) and takes no idle samples or captures. The foreground hook stays registered and only forwards a window handle. Anti-cheat software such as Riot Vanguard may still object to hooks, so this is not a guarantee: stop the agent before a game it has not been checked against. The list ships with common anti-cheat games and is editable.
- **Never hidden.** It runs in a console the user started, refuses to run as a service or in session 0, has no autostart, and `stop` and `wipe --yes` end and erase it. Config defaults are compiled in, never read from a sample file.
- **No network.** No network crate is allowed in the dependency tree; CI fails if one appears.
- **Retention is settable, default permanent.** Local retention is `retention_days` per data class in the config; `permanent` is the default and nothing purges unless set. A purge pass exists and is tested so a lower value works.
- **No captured data in the repository.** Tests use synthetic events only.

## Collectors (phase 1)

| Collector | Source | Default | Writes |
|---|---|---|---|
| foreground | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` on a thread with a message loop | on | an interval per foreground exe: start, end, exe name, category |
| idle | `GetLastInputInfo` sampled every 5 s | on | idle intervals once the idle time passes a threshold (default 120 s) |
| session | `WTSRegisterSessionNotification` on a message-only window: lock, unlock, logon, logoff, remote connect | on | instant events |
| power | `RegisterPowerSettingNotification` (AC/battery, display on/off) plus `WM_POWERBROADCAST` suspend and resume on a hidden top-level window | on | instant events |
| title | `GetWindowText` of the foreground window | off | title on the foreground interval |
| ocr | `PrintWindow(PW_RENDERFULLCONTENT)` then Windows.Media.Ocr, on window change and every N seconds while unchanged | off, step 2 | text row; minimised windows are skipped, images never touch disk |

OCR and title are built after the local-only core is verified on a real machine; this change builds the first four collectors plus store, report and metrics, then OCR in a second change.

**Foreground details.** The hook is out-of-context, so the callback only posts the window handle to the agent's own channel; lookups happen off the callback. De-duplicate repeats of the same exe. Ignore shell windows by class (`Shell_TrayWnd`, `Shell_SecondaryTrayWnd`, `NotifyIconOverflowWindow`, `XamlExplorerHostIslandWindow`, `TaskSwitcherWnd`, `ForegroundStaging`) so a tray click does not end the app interval. For `ApplicationFrameHost.exe`, resolve the real app from child windows after a 300 ms delay and re-check once. Every Electron app shares the class `Chrome_WidgetWin_1`, so identity is the exe name, and a per-exe category map (editable, shipped defaults) names the category (browser, editor, chat, media, game, terminal, other).

**Intervals cannot lie.** A row in `events` is written once, when its interval closes, and never changed. Intervals still open live in memory and are mirrored to `meta.open_state` with the heartbeat in the same transaction as every batch, so they survive a crash. At start the agent closes any such interval at the last heartbeat and records the time it was not running as `unknown`. While running, a gap of more than 30 s between one-second ticks (sleep with no suspend message, a frozen machine) closes everything at the last tick and records the gap as `unknown`; a wall clock that moves backwards closes at the old time and records `clock_jump`. Suspend and resume also arrive through `RegisterSuspendResumeNotification`. Signals dropped because the bounded channel was full are counted and recorded as `dropped`, then the foreground is read again. Durations come from the wall clock; a skew that the tick check cannot see is a known limit.

**Threads.** One hook thread owns a hidden top-level window (message-only windows do not receive suspend and resume) and the message loop; callbacks only try-send into a bounded channel. The main thread drains it, runs the engine, and writes. A panic is caught, open intervals are closed, and Ctrl+C, console close, logoff and shutdown all request a clean stop. A second instance is refused by an exclusive lock file that the OS drops if the process dies. The stop event is created with the default security descriptor, so only the creating user can signal it.

## Storage

SQLite in WAL mode (with `secure_delete`) at `%LOCALAPPDATA%\rhen-watch\activity.db`. On first run the folder's inherited permissions are removed with `icacls` so only the current user (not Administrators or SYSTEM inheritance) can read it, including the WAL and SHM files. A network-share path prints a warning. Tables: `events` (id TEXT primary key generated on the device, device, ts_start, ts_end, source, kind, attrs JSON), `metrics` (per-minute CPU time, working set, database size, event and drop counts), `meta` (schema version, device id, heartbeat, open state). The id exists before any later upload, so a future uploader is idempotent. Writes are one transaction per batch.

## Interface

`rhen-watch run [--for SECONDS]` runs in the foreground until Ctrl+C, `rhen-watch stop` or the time limit; it unhooks and flushes on exit and on panic. `rhen-watch report [--day YYYY-MM-DD]` prints time per app and category, idle and locked time, `unknown` gaps and the collectors' own cost. `rhen-watch status`, `config init|path`, `wipe --yes`. No background service or autostart in phase 1; that is a separate decision.

## Budget (to agree with Jondi)

Under 1% of one core on average and under 50 MB working set for phase 1, measured by the agent's own metrics over a normal day. The spike numbers are PowerShell numbers, so no Rust figure is claimed until measured.

## Server half (not in this change)

A later change adds one migration, an ingest endpoint with its own scope, a retention setting, and a boundary rule and test that keep the engine, scheduler and pulse from reading the new tables. It adds no MCP tools (the `tools/list` budget is capped).

## Tests

Pure logic is tested on Linux and Windows runners: interval building, de-duplication, the shell-class filter, game suppression, stall and clock-jump handling, crash recovery from the open-state record, retention purge, the report, config parsing, and a simulated day through the runner with a fake OS. The Windows API layer is behind a trait and is compiled and linted on `windows-latest`; its behaviour is confirmed by the manual checklist in the tool's README, which is observation-only. Still to add: a kill-and-restart test of the real binary on `windows-latest`.

## Known limits (phase 1)

- If the agent starts while the session is already locked, the first lock interval is not recorded as such; the initial lock state is not read yet.
- A kill-and-restart test of the real binary on `windows-latest` is still to add.
- A suspend whose resume message is lost would leave the `suspended` interval open until the next resume or stop.
- `rhen-watch stop` uses a per-logon-session event, so a remote desktop session cannot stop an agent running in the console session; use Ctrl+C there.
- Store writes that fail are kept in memory and retried each second; the agent exits after about a minute of consecutive failures.
- Retention purge runs on the first tick of each UTC day, then shrinks the write-ahead log.
