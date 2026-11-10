//! The install-time pieces shared by `install`, `uninstall` and the settings window: where the program lives,
//! stopping and starting the agent, closing an open settings window, and turning start-at-logon on and off through
//! one code path (the per-user tasks, with the Run entry as the fallback).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::windows as win;
use crate::app_model::{self, AutostartState, StartPlan};
use crate::restart::Autostart;

pub const ELEVATED_AGENT: &str = "an agent is running as administrator; use tray Quit or an elevated prompt";

pub fn install_dir() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("Programs").join("rhen-watch"))
        .ok_or_else(|| "LOCALAPPDATA is not set".to_string())
}

/// Wait until none of `files` is held open by a running copy (Windows will not replace or delete a running program).
pub fn wait_released(files: &[PathBuf]) -> Result<(), String> {
    let started = Instant::now();
    loop {
        let busy: Vec<_> = files
            .iter()
            .filter(|f| f.exists() && std::fs::OpenOptions::new().write(true).open(f).is_err())
            .collect();
        if busy.is_empty() {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(10) {
            return Err(format!("{} is still running; close it and try again", busy[0].display()));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Ask a running agent to stop and wait until its lock is free.
pub fn stop_and_wait() -> Result<(), String> {
    use win::StopSignal;
    let data = crate::paths::data_dir()?;
    match win::signal_stop(&data) {
        StopSignal::Sent => {}
        StopSignal::NotRunning => return Ok(()),
        StopSignal::AccessDenied => return Err(ELEVATED_AGENT.into()),
    }
    let lock = data.join("run.lock");
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        match std::fs::OpenOptions::new().write(true).open(&lock) {
            Ok(f) if f.try_lock().is_ok() => return Ok(()),
            Err(_) => return Ok(()),
            _ => std::thread::sleep(Duration::from_millis(200)),
        }
    }
    Err("the running agent did not stop within 10 seconds".into())
}

/// Close an open settings window (`WM_CLOSE`, like its close button) and wait up to 5 s for it to go. An install or
/// uninstall calls this before it changes anything, because the window's process holds the program file; if the window
/// stays, the error says so and nothing has been touched.
pub fn close_app_window() -> Result<(), String> {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let hwnd = win::app_window();
        if hwnd == 0 {
            return Ok(());
        }
        win::post_close(hwnd);
        if Instant::now() >= until {
            return Err("the rhen-watch settings window is open and did not close; close it and try again (nothing was changed)".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Start the agent detached from this process: it outlives a console, shows no window of its own and does not
/// inherit this process's output pipes (a script capturing `install`'s output would otherwise wait for it for ever).
pub fn spawn_agent(gui: &Path) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    win::stop_std_handle_inheritance();
    std::process::Command::new(gui)
        .arg("run")
        .creation_flags(0x0000_0008 | win::CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
}

/// Turn start-at-logon on: both tasks (logon start and keep-alive), or the Run entry when they cannot be registered.
/// `start_now` is `install`'s: start the agent through the new task and prove it came up (undoing the task if not).
/// The settings window passes false: it must not start a second agent. The reason a task could not be registered is
/// left in `restart-reason.txt` for `status`.
pub fn enable_autostart(gui: &Path, data: &Path, start_now: bool) -> Result<Autostart, String> {
    let mut autostart = crate::restart::plan(win::register_task(gui));
    if start_now && autostart.start_via_task() {
        // A task only restarts a process it launched, so the agent must be started through it.
        if let Err(e) = win::run_task() {
            let _ = win::delete_task();
            autostart = crate::restart::plan(Err(e));
        } else {
            // The task can register and "run" yet never launch (no interactive session). Prove the agent is up;
            // if not, undo the task and fall back to the Run entry, so the user is never left with nothing.
            let until = Instant::now() + Duration::from_secs(15);
            while !crate::cli::agent_running(data) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(200));
            }
            if !crate::cli::agent_running(data) {
                let _ = win::delete_task();
                autostart = crate::restart::plan(Err("the task was registered but did not start the agent".into()));
            }
        }
    }
    let reason_file = data.join(crate::cli::REASON_FILE);
    match autostart.reason() {
        Some(reason) => {
            crate::log::warn(&format!(
                "restart on crash is off: {reason}; using the start-at-logon entry instead"
            ));
            let _ = std::fs::create_dir_all(data);
            let _ = std::fs::write(&reason_file, reason);
        }
        None => {
            let _ = std::fs::remove_file(&reason_file);
        }
    }
    if autostart.keep_run_entry() {
        win::set_autostart(&format!("\"{}\" run", gui.display()))?;
    } else {
        // One mechanism: with the task registered, the Run entry would start a second copy at logon.
        win::clear_autostart()?;
    }
    Ok(autostart)
}

/// Turn start-at-logon off: both tasks and the Run entry. A running agent is left running (this only decides what
/// happens at the next logon and after a crash).
pub fn disable_autostart() -> Result<(), String> {
    win::delete_task()?;
    win::clear_autostart()
}

/// What start-at-logon is now: a live look at the tasks and the Run entry.
pub fn autostart_state() -> AutostartState {
    app_model::autostart_state(win::task_count(), win::run_entry_present())
}

/// The program for a start from the settings window and whether it is the installed one. Turning start-up on
/// registers this path with Task Scheduler, so a copy run from a download folder is refused.
pub fn installed_gui() -> Result<PathBuf, String> {
    let installed = install_dir()?.join("rhen-watchw.exe");
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    match (me.canonicalize(), installed.canonicalize()) {
        (Ok(a), Ok(b)) if a == b => Ok(installed),
        _ => Err("start-up can only be changed from the installed copy (run rhen-watch.exe install first)".into()),
    }
}

/// Start recording from the settings window. Checks the settings first (a refusal is said here, in words, instead
/// of in a message box), starts through the task when there is one, directly otherwise, and waits for the agent to
/// hold the lock. It never touches `stopped-by-user.txt`: `run` clears it once it has the lock.
pub fn start_agent(data: &Path) -> Result<(), String> {
    crate::cli::check_settings(data)?;
    if crate::cli::agent_running(data) {
        return Ok(());
    }
    let begun = std::time::SystemTime::now();
    let mut child = match app_model::start_plan(win::task_present()) {
        StartPlan::Task => {
            win::run_task()?;
            None
        }
        StartPlan::Direct => {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let gui = exe.with_file_name("rhen-watchw.exe");
            Some(spawn_agent(if gui.exists() { &gui } else { &exe }).map_err(|e| format!("could not start it: {e}"))?)
        }
    };
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        if crate::cli::agent_running(data) {
            return Ok(());
        }
        // A refusal the new `run` left behind (written after we asked) explains an agent that never appears.
        let refused = std::fs::metadata(data.join(crate::cli::NOT_STARTING_FILE))
            .and_then(|m| m.modified())
            .is_ok_and(|t| t >= begun);
        if refused && let Ok(why) = std::fs::read_to_string(data.join(crate::cli::NOT_STARTING_FILE)) {
            return Err(format!("recording did not start: {}", why.trim()));
        }
        if let Some(status) = child.as_mut().and_then(|c| c.try_wait().ok().flatten()) {
            return Err(format!(
                "recording did not start (it exited: {status}); see rhen-watch.log in {}",
                data.display()
            ));
        }
        if Instant::now() >= until {
            return Err(format!(
                "recording did not start within 15 seconds; see rhen-watch.log in {}",
                data.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Stop and start again, for a setting that is read when the agent starts.
pub fn restart_agent(data: &Path) -> Result<(), String> {
    stop_and_wait()?;
    start_agent(data)
}

// ---- the user PATH ----

/// The spellings of the install folder an existing PATH entry may use.
fn path_spellings(dest: &Path) -> [String; 2] {
    [
        dest.to_string_lossy().into_owned(),
        r"%LOCALAPPDATA%\Programs\rhen-watch".to_string(),
    ]
}

/// Put the install folder on the user's PATH (no admin: HKCU), once. The registry type and every other entry are
/// kept as they are. Returns whether anything was changed.
pub fn add_to_user_path(dest: &Path) -> Result<bool, String> {
    let spellings = path_spellings(dest);
    let refs = [spellings[0].as_str(), spellings[1].as_str()];
    let (value, kind) = win::user_path_read()?.unwrap_or_default();
    let Some(new) = crate::user_path::add(&value, refs[0], &refs) else {
        return Ok(false);
    };
    // A value that was plain text stays plain text; a new one is expandable like the system's own.
    win::user_path_write(
        &new,
        if kind == 0 {
            windows_sys::Win32::System::Registry::REG_EXPAND_SZ
        } else {
            kind
        },
    )?;
    win::broadcast_environment_change();
    Ok(true)
}

/// Take exactly our entry off the user's PATH. Not being there is fine.
pub fn remove_from_user_path(dest: &Path) -> Result<bool, String> {
    let spellings = path_spellings(dest);
    let refs = [spellings[0].as_str(), spellings[1].as_str()];
    let Some((value, kind)) = win::user_path_read()? else {
        return Ok(false);
    };
    let Some(new) = crate::user_path::remove(&value, &refs) else {
        return Ok(false);
    };
    win::user_path_write(&new, kind)?;
    win::broadcast_environment_change();
    Ok(true)
}

// ---- the Start menu entry ----

const SHORTCUT_FILE: &str = "rhen-watch.lnk";
const SHORTCUT_DESCRIPTION: &str = "rhen-watch: pause or resume recording, set app categories, choose how long to keep data";

/// Write the icon next to the program and a Start menu shortcut to `rhen-watchw.exe app`. Returns the shortcut's path.
pub fn create_start_menu_shortcut(dest: &Path, gui: &Path) -> Result<PathBuf, String> {
    let made = make_shortcut(dest, gui);
    if made.is_err() {
        // Nothing half-made is left behind.
        remove_start_menu_shortcut(dest);
    }
    made
}

fn make_shortcut(dest: &Path, gui: &Path) -> Result<PathBuf, String> {
    let icon = dest.join(crate::icons::INSTALLED_ICON_FILE);
    std::fs::write(&icon, crate::icons::RECORDING_ICO).map_err(|e| format!("cannot write {}: {e}", icon.display()))?;
    let folder = super::windows_shortcut::start_menu_programs_dir()?;
    std::fs::create_dir_all(&folder).map_err(|e| format!("cannot create {}: {e}", folder.display()))?;
    let lnk = folder.join(SHORTCUT_FILE);
    super::windows_shortcut::create(&lnk, gui, "app", dest, &icon, SHORTCUT_DESCRIPTION)?;
    // Read it back: a shortcut that does not point at the installed program is worse than none.
    let (target, args) = super::windows_shortcut::read(&lnk)?;
    if !same_file(Path::new(&target), gui) || args != "app" {
        return Err(format!("the shortcut reads back as \"{target} {args}\", not the installed program"));
    }
    Ok(lnk)
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Remove the shortcut and the icon file. Not being there is fine; a failure is said, not fatal.
pub fn remove_start_menu_shortcut(dest: &Path) {
    if let Ok(folder) = super::windows_shortcut::start_menu_programs_dir() {
        let lnk = folder.join(SHORTCUT_FILE);
        if let Err(e) = std::fs::remove_file(&lnk)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            crate::log::warn(&format!("could not remove {}: {e}", lnk.display()));
        }
    }
    let _ = std::fs::remove_file(dest.join(crate::icons::INSTALLED_ICON_FILE));
}
