//! `rhen-watch install` and `uninstall` on macOS: a menu bar app in `~/Applications` started at login by a
//! per-user LaunchAgent. No administrator rights, nothing outside the user's own folders.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use super::macos as mac;
use super::macos_rules::{LABEL, info_plist, launch_agent_plist};
use crate::cli::agent_running;

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

pub fn app_dir() -> Result<PathBuf, String> {
    Ok(home()?.join("Applications").join("rhen-watch.app"))
}

pub fn agent_plist() -> Result<PathBuf, String> {
    Ok(home()?.join("Library").join("LaunchAgents").join(format!("{LABEL}.plist")))
}

fn domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

fn run(program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("cannot run {program}: {e}"))
}

fn checked(program: &str, args: &[&str]) -> Result<(), String> {
    let out = run(program, args)?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "{program} {} failed ({}): {}",
        args.join(" "),
        out.status,
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// Unload the LaunchAgent if it is loaded (launchd stops the agent and waits for it), then stop any copy
/// started by hand. Only our own process is signalled.
fn stop_everything(data: &Path) -> Result<(), String> {
    // Not loaded is the normal case on a first install, so the result is not an error.
    let _ = run("/bin/launchctl", &["bootout", &format!("{}/{LABEL}", domain())]);
    let started = Instant::now();
    while agent_running(data) {
        if started.elapsed() > Duration::from_secs(1) {
            mac::signal_stop(data)?;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let started = Instant::now();
    while agent_running(data) {
        if started.elapsed() > Duration::from_secs(10) {
            return Err("the running agent did not stop within 10 seconds".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("new");
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

/// Build the app next to the old one, sign it ad hoc, then swap it in, so a failure leaves the old app as it was.
fn stage_app(app: &Path) -> Result<(), String> {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let staged = app.with_extension("app.new");
    let _ = std::fs::remove_dir_all(&staged);
    let macos = staged.join("Contents").join("MacOS");
    std::fs::create_dir_all(&macos).map_err(|e| format!("cannot create {}: {e}", macos.display()))?;
    std::fs::copy(&me, macos.join("rhen-watch")).map_err(|e| format!("cannot copy the program: {e}"))?;
    std::fs::write(staged.join("Contents").join("Info.plist"), info_plist(env!("CARGO_PKG_VERSION")))
        .map_err(|e| format!("cannot write Info.plist: {e}"))?;
    let staged_s = staged.to_string_lossy().to_string();
    // A downloaded copy carries the quarantine flag; clear it on our copy so the login start is not blocked.
    let _ = run("/usr/bin/xattr", &["-cr", &staged_s]);
    // Ad hoc signature: required on arm64 Macs, and it gives the bundle a stable identity.
    if let Err(e) = checked("/usr/bin/codesign", &["--force", "--sign", "-", &staged_s]) {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(e);
    }
    // Move the old app aside first, so a failed swap can put it back and never leaves no app at all.
    let old = app.with_extension("app.old");
    let _ = std::fs::remove_dir_all(&old);
    let had_old = app.exists();
    if had_old {
        std::fs::rename(app, &old).map_err(|e| format!("cannot move the old {} aside: {e}", app.display()))?;
    }
    if let Err(e) = std::fs::rename(&staged, app) {
        if had_old {
            let _ = std::fs::rename(&old, app);
        }
        let _ = std::fs::remove_dir_all(&staged);
        return Err(format!("cannot move the app into {}: {e}", app.display()));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

pub fn install(data: &Path) -> Result<(), String> {
    if mac::is_root() {
        return Err("run install as the logged-in user, not with sudo".into());
    }
    // A broken config would only show up at the next login; refuse now instead.
    crate::cli::load_run_settings(data)?;
    mac::restrict_dir(data)?;
    let app = app_dir()?;
    let plist = agent_plist()?;
    stop_everything(data)?;
    if let Some(parent) = app.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    stage_app(&app)?;
    let program = app.join("Contents").join("MacOS").join("rhen-watch");
    if let Some(parent) = plist.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    write_atomic(
        &plist,
        &launch_agent_plist(&program.to_string_lossy(), &data.to_string_lossy(), &home()?.to_string_lossy()),
    )?;
    checked("/bin/launchctl", &["bootstrap", &domain(), &plist.to_string_lossy()])?;
    let started = Instant::now();
    while !agent_running(data) {
        if started.elapsed() > Duration::from_secs(10) {
            return Err(format!(
                "installed, but the agent did not start recording within 10 seconds; see launchd.log in {}",
                data.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    crate::log::info(&format!("installed to {}", app.display()));
    println!("It starts when you log in and is running now (look for the icon in the menu bar).");
    println!("Report:    {} report", program.display());
    println!("Stop:      {} stop", program.display());
    println!("Uninstall: {} uninstall   (add --purge to delete your data too)", program.display());
    Ok(())
}

/// Unload and remove the LaunchAgent and the app. The caller deletes the data on `--purge`.
pub fn uninstall(data: &Path) -> Result<(), String> {
    if mac::is_root() {
        return Err("run uninstall as the logged-in user, not with sudo".into());
    }
    stop_everything(data)?;
    let plist = agent_plist()?;
    if plist.exists() {
        std::fs::remove_file(&plist).map_err(|e| format!("cannot remove {}: {e}", plist.display()))?;
    }
    let app = app_dir()?;
    if app.exists() {
        // Removing the running program's own file is allowed on macOS; this process keeps running.
        std::fs::remove_dir_all(&app).map_err(|e| format!("cannot remove {}: {e}", app.display()))?;
    }
    Ok(())
}
