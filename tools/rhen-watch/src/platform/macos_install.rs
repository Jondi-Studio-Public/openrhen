//! `rhen-watch install` and `uninstall` on macOS: a menu bar app in `~/Applications` started at login by a
//! per-user LaunchAgent. No administrator rights, nothing outside the user's own folders.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use super::macos as mac;
use super::macos_rules::{BIN_DIR, LABEL, add_path_block, info_plist, launch_agent_plist, path_has, profile_for_shell, remove_path_block};
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

fn command_link() -> Result<PathBuf, String> {
    Ok(home()?.join(BIN_DIR).join("rhen-watch"))
}

/// Link `~/.local/bin/rhen-watch` to the installed program and, when that folder is not on PATH yet, add it in
/// the login shell's start-up file. Returns what to tell the user about typing `rhen-watch`.
fn link_command(program: &Path) -> Result<String, String> {
    let link = command_link()?;
    let bin = link.parent().expect("link has a parent").to_path_buf();
    std::fs::create_dir_all(&bin).map_err(|e| format!("cannot create {}: {e}", bin.display()))?;
    match std::fs::symlink_metadata(&link) {
        Ok(m) if m.file_type().is_symlink() => {
            std::fs::remove_file(&link).map_err(|e| format!("cannot replace {}: {e}", link.display()))?
        }
        // Someone else's file: never overwrite it.
        Ok(_) => {
            return Ok(format!(
                "{} already exists and is not a link made by rhen-watch, so it was left alone; run {} instead.",
                link.display(),
                program.display()
            ));
        }
        Err(_) => {}
    }
    std::os::unix::fs::symlink(program, &link).map_err(|e| format!("cannot link {}: {e}", link.display()))?;
    let path = std::env::var("PATH").unwrap_or_default();
    if path_has(&path, &bin.to_string_lossy()) {
        return Ok("Type rhen-watch in Terminal to use it.".into());
    }
    let shell = std::env::var("SHELL").ok();
    let Some(name) = profile_for_shell(shell.as_deref()) else {
        return Ok(format!(
            "Add {} to your shell's PATH to type rhen-watch; until then run {}.",
            bin.display(),
            program.display()
        ));
    };
    let profile = home()?.join(name);
    let text = match std::fs::read_to_string(&profile) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", profile.display())),
    };
    if let Some(new) = add_path_block(&text) {
        // Only appends, and writes through a linked start-up file rather than replacing the link.
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&profile)
            .map_err(|e| format!("cannot open {}: {e}", profile.display()))?;
        f.write_all(&new.as_bytes()[text.len()..])
            .map_err(|e| format!("cannot write {}: {e}", profile.display()))?;
    }
    Ok(format!(
        "Added {} to PATH in {}. Open a new Terminal window, then type rhen-watch.",
        bin.display(),
        profile.display()
    ))
}

/// Undo `link_command`: remove the link only if it still points at our program, and the PATH block from every
/// start-up file `install` may have written.
fn unlink_command(program: &Path) -> Result<(), String> {
    let link = command_link()?;
    if std::fs::read_link(&link).is_ok_and(|to| to == program) {
        std::fs::remove_file(&link).map_err(|e| format!("cannot remove {}: {e}", link.display()))?;
    }
    for name in [".zprofile", ".bash_profile"] {
        let profile = home()?.join(name);
        let Ok(text) = std::fs::read_to_string(&profile) else { continue };
        if let Some(new) = remove_path_block(&text) {
            std::fs::write(&profile, new).map_err(|e| format!("cannot write {}: {e}", profile.display()))?;
        }
    }
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
    // The agent is installed and running by now, so a failed link is a note, not a failed install.
    let note =
        link_command(&program).unwrap_or_else(|e| format!("Could not put rhen-watch on PATH ({e}); run {} instead.", program.display()));
    println!("It starts when you log in and is running now (look for the icon in the menu bar).");
    println!("{note}");
    println!("Report:    rhen-watch report");
    println!("Stop:      rhen-watch stop");
    println!("Uninstall: rhen-watch uninstall   (add --purge to delete your data too)");
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
    unlink_command(&app.join("Contents").join("MacOS").join("rhen-watch"))?;
    if app.exists() {
        // Removing the running program's own file is allowed on macOS; this process keeps running.
        std::fs::remove_dir_all(&app).map_err(|e| format!("cannot remove {}: {e}", app.display()))?;
    }
    Ok(())
}
