# Testing rhen-watch on a real Windows PC

This is the script for the test phase. Linux tests cannot prove the Windows parts: the foreground hook, lock, sleep and display messages, the tray, autostart and the data folder permissions. You prove them here.

Read the [README](README.md) first for what the agent records.

## The rule: observation only

- Do not script, simulate or inject any input. No AutoHotkey, no `SendKeys`, no mouse movers.
- Do not open, close, focus or resize other apps from a script.
- Do not play a game while testing. Check your games first (step 2).
- Every step below is something you do by hand. The PowerShell only reads output.

Lines marked are what the report prints once the other report changes are in: a `Paused` line, an `Agent off` line for a clean stop, and the `Events` section. Before that, the line is simply missing. Do not file a missing line as a bug until those changes have shipped.

## 0. Stop command

Run this at any time to stop the agent:

```powershell
& "$env:LOCALAPPDATA\Programs\rhen-watch\rhen-watch.exe" stop
```

Set a short name for the rest of this script:

```powershell
$rw = "$env:LOCALAPPDATA\Programs\rhen-watch\rhen-watch.exe"
```

## 1. Get the binary

1. Open the latest green run of CI on `main`. In its Artifacts, download `rhen-watch-windows`. That zip comes from the `rhen-watch (windows-latest)` job. For a build under test, use the run for that commit instead.
2. Unzip it into a folder such as `$env:USERPROFILE\Downloads\rhen-watch`. The folder must hold both `rhen-watch.exe` and `rhen-watchw.exe`.
3. Remove the download mark from both files:

```powershell
Get-ChildItem "$env:USERPROFILE\Downloads\rhen-watch" -Recurse -File | Unblock-File
```

The build is not signed. Expect warnings:

- SmartScreen may say "Windows protected your PC". Choose More info, then Run anyway.
- Defender may warn about a program that sets a Run entry, hooks window events or restricts a folder. That is what this program does. Say what it flagged. Do not add an exclusion for the whole folder.
- If Defender quarantines a file, stop and report it. Do not work around it.

## 2. Check your games

While a game from the built-in list is in front, the agent records only that something was suppressed. It does not record the name. Matching is by exe name only.

Write down the exe name of each game you play (Task Manager, Details tab, while the game runs). Put them in `$mine`, then compare:

```powershell
$mine = @('mygame.exe', 'othergame.exe')   # your games
$builtin = @(
  'valorant.exe','valorant-win64-shipping.exe','vgc.exe','riotclientservices.exe','league of legends.exe',
  'fortniteclient-win64-shipping.exe','easyanticheat.exe','battleye.exe','r5apex.exe','r5apex_dx12.exe',
  'escapefromtarkov.exe','destiny2.exe','rainbowsix.exe','rainbowsix_vulkan.exe','cs2.exe','csgo.exe','dota2.exe',
  'overwatch.exe','tslgame.exe','rustclient.exe','eldenring.exe','gta5.exe','gtav.exe','cod.exe','modernwarfare.exe',
  'bf2042.exe','thefinals.exe','tarkov.exe','dayz_x64.exe','apexlegends.exe')
$mine | Where-Object { $builtin -notcontains $_.ToLower() }
```

This list is `DEFAULT_GAMES` in `src/categories.rs`. If the source has changed, that file wins.

Whatever the last command prints is missing. Add it to `extra_games`. This replaces the whole list, so give all of your missing games in one command:

```powershell
& $rw config set extra_games "mygame.exe,othergame.exe"
& $rw config show | Select-String extra_games
```

The agent reads the config only when it starts. After install (step 3), stop it and start it again for the change to apply.

For a game you cannot check, use Pause in the tray before you play. Pause survives a reboot. Choose Resume when you are done.

## 3. Install from a normal prompt

Open a normal PowerShell. Do not choose Run as administrator. Then:

```powershell
cd "$env:USERPROFILE\Downloads\rhen-watch"
.\rhen-watch.exe install
```

Expected output:

```text
installed to C:\Users\<you>\AppData\Local\Programs\rhen-watch
It starts when you log on and is running now (look for the tray icon).
```

Then check:

```powershell
& $rw status
```

Expected lines:

```text
agent: running
database: 0.01 MB, 3 events         (any size; events is 1 or more)
last heartbeat: 4 s ago             (under 35)
open intervals: 2                   (1 or more while it runs)
```

Open a new PowerShell (not the one you installed from) and run `rhen-watch status`: it must work without the full path, because `install` put the install folder on your user PATH. `($env:Path -split ';') -contains "$env:LOCALAPPDATA\Programs\rhen-watch"` is `True`; installing again must not add it twice. The tray icon must show (a green disc while recording). Task Manager, Startup apps, must list `rhen-watch`. Press the Windows key and type `rhen-watch`: the Start menu must list an app called `rhen-watch` with the green icon. If it is missing, `install` printed a warning and `rhen-watch.log` says why; the tray icon's Open settings still works.

If you added games in step 2 after installing, restart the agent now:

```powershell
& $rw stop
# stop returns before the agent has let go of its lock: wait until it has (up to 15 s)
$until = (Get-Date).AddSeconds(15)
while ((& $rw status) -match 'agent: running' -and (Get-Date) -lt $until) { Start-Sleep -Seconds 1 }
Start-Process "$env:LOCALAPPDATA\Programs\rhen-watch\rhen-watchw.exe" -ArgumentList 'run'
```

## 3a. The settings window

Start it from the Start menu entry `rhen-watch` (or the tray icon's Open settings, or `& "$env:LOCALAPPDATA\Programs\rhen-watch\rhen-watchw.exe" app`). It is a separate program from the recorder: closing it never stops recording. These checks need a real desktop; CI only builds the window hidden and reads its controls back (`app --smoke`).

| Step | What you do | Expected |
| --- | --- | --- |
| Open twice | Open it, then open it again from the tray. | One window; the second launch brings the first to the front. |
| Overview | Look at the Overview tab. | `Recording`, the privacy line `Data stays on this PC. rhen-watch has no network code.`, today's report in the box, and the window icon is the green disc. |
| Pause | Press Pause recording. Wait for the headline. Look at the tray icon and menu. | The headline says `Paused` within a few seconds, the tray icon turns grey and its menu says Resume recording. Press Resume recording: green again. In `report`, `Paused:` appears. |
| Tray in step | Pause from the tray menu instead. | Within 2 seconds the window says `Paused` too. |
| Stop and start | Press Stop recording. Then Start recording. | `Not recording`, then `Recording`. After Stop, the keep-alive must not bring it back within 2 minutes. |
| Not running | Quit from the tray, open the window from the Start menu. | `Not recording` and a Start recording button; opening the window did not start recording. |
| Refused start | Put `idle_threshold_secs = 0` in `config.toml`. Press Start recording. | The window says why it did not start. Fix the file and press Start recording again. |
| Apps | Use a few apps no category knows, open the Apps tab. | They are listed with time, `rhen-watch` itself is not. Pick one, type `editor`, press Set. The line says it takes effect when recording restarts; `categories.toml` has the entry. Press Restart recording. |
| Keep data | On Settings choose `30 days` and press Apply with more than 30 days recorded. | A question says how many recorded events would be deleted. No leaves the file unchanged. |
| Start with Windows | Untick it, Apply. | The note says rhen-watch stays closed after logoff and is no longer restarted after a crash; `schtasks /Query /TN rhen-watch` fails. The recorder keeps running. Tick it again, Apply: the tasks are back and there is still one `rhen-watchw` recording process. |
| High DPI | Drag the window to a monitor with a different scale. | The text and controls resize with it. |
| Install while open | Leave the window open and run `.\rhen-watch.exe install` again. | The window closes by itself and the install completes. |
| Uninstall | Run `uninstall`. | The Start menu entry is gone, and so are `rhen-watch.lnk` and `rhen-watch.ico`. |

Pause and resume from the window work because, on a real logon, the scheduled-task agent and your own windows are both on the interactive desktop (WinSta0) of your session. CI cannot show this: the task agent there runs on a window station its shell cannot see, so CI checks the same message path against a second agent it starts itself.

## 4. Day 1

Use the PC normally. At each step, wait the stated time, then run `& $rw report` and look for the line shown. Times are examples; yours will differ by a minute or so.

| Step | What you do | Expected in `report` |
| --- | --- | --- |
| App switches | Alt-Tab across Notepad, Calculator, Edge and Explorer for a few minutes | Each app under `By app`: `notepad.exe`, `calculatorapp.exe` (not `applicationframehost.exe`), `msedge.exe`. `explorer.exe` appears only for real Explorer windows. The taskbar and Alt-Tab overlay do not appear. |
| Lock | Press Win+L. Leave it 2 minutes. Unlock. | `Screen locked: 2m`. The `Input:` figure in `Your day at the PC` did not grow during the lock. |
| Start while locked | Run `& $rw stop`, then `Start-Job { Start-Sleep 30; Start-Process "$env:LOCALAPPDATA\Programs\rhen-watch\rhen-watchw.exe" -ArgumentList 'run' }` and press Win+L within 30 s. Leave it locked 2 minutes, then unlock (keep that PowerShell window open until then). | `Screen locked` covers the time from the agent's start until you unlocked; no app time inside it. |
| Display sleep | Let the display turn off for 3 minutes (or press the monitor power button). Wake it. | `Display off: 3m` |
| Sleep and resume | Sleep the PC for 5 minutes. Wake it. | `Suspended: 5m`. There is no `Gaps where nothing is known` section for it. |
| Idle over 2 minutes | Sit in front of one app for 4 minutes and touch nothing. | `In front of an app: ...  (of which idle: 2m)` rises by about 2 minutes: idle starts after 120 s of no input. `Input:` does not grow. |
| Tray Pause | Right-click the tray icon, choose Pause recording. Wait 2 minutes. Choose Resume recording. | `Paused: 2m`. No app time during the pause. The tray menu shows Resume while paused. |
| Tray Quit | Choose Quit. Wait 1 minute. Start it again with `Start-Process "$env:LOCALAPPDATA\Programs\rhen-watch\rhen-watchw.exe" -ArgumentList 'run'`. | Under `Events`: `agent/stop: 1` and a second `agent/start`. `Agent off: 1m` and no `Unknown` line for that minute. |
| Reboot | Restart Windows. Log on. Do not start anything by hand. | The tray icon returns. `status` says `agent: running`. `Agent off` for the time it was down. No `previous run ended without a clean stop` gap. |

Rules for reading the report:

- A suspend you did by sleeping is `Suspended`, not a gap. A `Gaps` section appears only after a kill or a crash.
- `Agent cost` should show under 1% CPU and under 50 MB.
- The shell windows (taskbar, Alt-Tab, Start) must never appear as apps.

## 5. Kill test

This is what a crash or a power cut looks like.

```powershell
& $rw status                                 # must say: restart on crash: yes (scheduled task)
Stop-Process -Name rhen-watchw -Force
Start-Sleep -Seconds 90                     # the keep-alive task restarts it within about a minute, on its own
& $rw status
& $rw report
```

Expected:

```text
Gaps where nothing is known:
  14:03-14:04  agent not running
```

and `Unknown (agent not running or machine stalled): 1m` (the gap is the time from the last heartbeat to the restart). `status` must say `agent: running` again without you starting it. If `status` said `restart on crash: no (...)`, the task could not be registered and the Run entry was used instead; start the agent by hand as `Start-Process "$env:LOCALAPPDATA\Programs\rhen-watch\rhen-watchw.exe" -ArgumentList 'run'`. A kill shorter than 10 seconds records no gap.

A clean Quit must not look like this. It shows `Agent off`, not `Unknown`.

## 6. Upgrade test

Do this when you have a newer build. Leave the agent running.

1. Download and unzip the newer build into a new folder. Run `Unblock-File` on it as in step 1.
2. Note the process id:

```powershell
(Get-Process rhen-watchw).Id
```

3. Install the new build over the running one:

```powershell
cd "$env:USERPROFILE\Downloads\rhen-watch-new"
.\rhen-watch.exe install
```

Expected: the same two output lines as in step 3, no error, and a different process id from `(Get-Process rhen-watchw).Id`. `& $rw status` says `agent: running`. Your earlier data is still in `report`.

## 7. Week run

Use the PC as normal for a week, with the agent installed. Each day:

```powershell
& $rw report --day (Get-Date).ToString('yyyy-MM-dd')
```

Check:

- `Agent cost` shows `CPU:` under 1% of one core on average, and `memory:` under 50 MB peak working set.
- After an overnight shutdown the day is not marked `(partial: ... min unknown)`.
- `database:` grows slowly. Write down the size on day 1 and day 7.
- Several days at once:

```powershell
& $rw report --from 2026-11-09 --to 2026-11-15
```

Each day starts with a `==== YYYY-MM-DD ====` line.

## 8. Hand the data back

Do not copy `activity.db` by hand while the agent runs. The newest rows are still in `activity.db-wal`. Use `export`. It takes a consistent copy and never overwrites a file:

```powershell
$out = "$env:USERPROFILE\Desktop\rhen-watch-handback"
New-Item -ItemType Directory $out | Out-Null
& $rw export "$out\activity.db"
& $rw status | Out-File -Encoding utf8 "$out\status.txt"
& $rw report --from 2026-11-09 --to 2026-11-15 | Out-File -Encoding utf8 "$out\report.txt"
Copy-Item "$env:LOCALAPPDATA\rhen-watch\rhen-watch.log*" $out
```

`export` prints the path and the size. Send the folder.

The database holds the exe name of every app you used. Read `report.txt` before you share anything.

## 9. Uninstall and purge

Run `uninstall` from the folder you downloaded, not from the installed copy. A program cannot delete itself, so the installed copy leaves its own folder behind.

```powershell
cd "$env:USERPROFILE\Downloads\rhen-watch"
.\rhen-watch.exe uninstall
```

Expected: `Uninstalled.` and `Your data is kept in ...`. Check:

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\rhen-watch"          # False
(([Environment]::GetEnvironmentVariable('Path','User')) -split ';') -contains "$env:LOCALAPPDATA\Programs\rhen-watch"   # False: the PATH entry is gone, other entries are untouched
Get-CimInstance Win32_StartupCommand | Where-Object Name -eq 'rhen-watch'   # prints nothing: no start-at-logon entry
Get-Process rhen-watch* -ErrorAction SilentlyContinue      # prints nothing
Test-Path "$env:LOCALAPPDATA\rhen-watch\activity.db"       # True: plain uninstall keeps your data
```

Then install again and test the purge (do the hand-back first):

```powershell
.\rhen-watch.exe install
.\rhen-watch.exe uninstall --purge
Test-Path "$env:LOCALAPPDATA\rhen-watch"                   # False: database, config, both logs and the folder are gone
```

The output lists each file with `deleted ...`. If you put your own files in the data folder, the folder stays and those files are untouched. `rhen-watch.log` and `rhen-watch.log.1` are deleted too.

`wipe --yes` deletes the same files but leaves the folder.

## 10. Known limits

Do not file these as bugs. They are known and written down.

- Gamepad and video input read as idle. Only keyboard and mouse count as input.
- One browser is one app. The report cannot tell what you did in it.
- A minimised window keeps its app time while it is the foreground window.
- The UAC secure desktop is invisible to the agent.
- Games are matched by exe name only.
- `stop` does not cross remote desktop sessions. Use Ctrl+C in the console that runs the agent.
- Task Manager shows the plain program icon for `rhen-watchw.exe`: the icons are in the window, the tray and the Start menu entry, not embedded in the file (no resource compiler is used).
- There is no uploader and no server setting in the window. Nothing leaves the PC.
- There is no Mac agent.
- Pause drops any lock, remote or suspend state in progress; Resume reads the lock and remote state again, but a suspend that began while paused is not recorded.
- Whether `SM_REMOTESESSION` clears after a Remote Desktop disconnect is not checked yet; if it does not, time after a disconnect shows as remote.
- The build is unsigned, so SmartScreen and Defender warnings are expected.

## 11. What to send when something is wrong

Send: what you did, the time, the line you expected, the line you got, and the hand-back folder from step 8. Say if the PC was on battery, on a remote desktop session, or had more than one display.
