//! The command line: shared by `rhen-watch` (console) and `rhen-watchw` (no console, for autostart).

use std::path::PathBuf;

use crate::categories::{self, CategoryFile};
use crate::config::{self, Config};
use crate::model::Ms;
use crate::tz::TzOffset;
#[cfg(windows)]
use crate::{engine, ids, platform, runner};
use crate::{paths, report, store};

const HELP: &str = "rhen-watch: local desktop activity recorder (observation only, nothing is sent anywhere)

USAGE
  rhen-watch run [--for SECONDS]     record until Ctrl+C, `rhen-watch stop`, or SECONDS have passed
  rhen-watch stop                    ask a running agent to stop and flush
  rhen-watch report [--day YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD] [--utc-offset-minutes N]
  rhen-watch status                  paths, size, last heartbeat, row counts
  rhen-watch export PATH             copy the database to a new file (safe while the agent runs; never overwrites)
  rhen-watch config init|path|show   write the default config / print its path / list every setting
  rhen-watch config set KEY VALUE    change one setting, keeping the file's comments (e.g. derive.session_gap_minutes 8)
  rhen-watch categories init [--from-config]|path|list [--uncategorised]|set EXE CATEGORY
                                     the per-exe category map (categories.toml); --from-config prints the
                                     [exe] text for an old config.toml [categories] table
  rhen-watch install                 copy to %LOCALAPPDATA%\\Programs\\rhen-watch, start at logon, start now
  rhen-watch uninstall [--purge]     stop, remove start at logon and the program (--purge also deletes your data: the
                                     database, config, logs and the data folder)
  rhen-watch wipe --yes              delete the database, its sidecar files, the config and the log files
";

pub fn main() {
    // The no-console build has nowhere to show a panic, so put it in the log.
    std::panic::set_hook(Box::new(|info| crate::log::error(&format!("internal error: {info}"))));
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match real_main(&args) {
        Ok(()) => 0,
        Err(e) => {
            crate::log::error(&e);
            1
        }
    };
    std::process::exit(code);
}

pub fn real_main(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("run") => cmd_run(&args[1..]),
        Some("stop") => cmd_stop(),
        Some("report") => cmd_report(&args[1..]),
        Some("status") => cmd_status(),
        Some("export") => cmd_export(&args[1..]),
        Some("config") => cmd_config(&args[1..]),
        Some("categories") => cmd_categories(&args[1..]),
        Some("wipe") => cmd_wipe(&args[1..]),
        Some("install") => cmd_install(),
        Some("uninstall") => cmd_uninstall(&args[1..]),
        Some("--help") | Some("-h") | Some("help") | None => {
            print!("{HELP}");
            Ok(())
        }
        Some(other) => Err(format!("unknown command \"{other}\"\n\n{HELP}")),
    }
}

fn flag_value<'a>(args: &'a [String], name: &str) -> Result<Option<&'a str>, String> {
    match args.iter().position(|a| a == name) {
        None => Ok(None),
        Some(i) => args
            .get(i + 1)
            .map(|v| Some(v.as_str()))
            .ok_or_else(|| format!("{name} needs a value")),
    }
}

fn dir() -> Result<PathBuf, String> {
    let d = paths::data_dir()?;
    std::fs::create_dir_all(&d).map_err(|e| format!("cannot create {}: {e}", d.display()))?;
    Ok(d)
}

/// The config for `run` and `report`: a leftover `[categories]` table stops both.
fn load_config(dir: &std::path::Path) -> Result<Config, String> {
    let cfg = Config::load(&dir.join("config.toml"))?;
    cfg.reject_legacy_categories()?;
    Ok(cfg)
}

/// Settings for `report`: a bad `categories.toml` is an error naming file, line and reason.
pub fn load_report_settings(dir: &std::path::Path) -> Result<(Config, categories::Catalogue), String> {
    let cfg = load_config(dir)?;
    let file = CategoryFile::load(&dir.join("categories.toml"))?;
    let catalogue = categories::Catalogue::with_file(&file, &cfg.extra_games);
    Ok((cfg, catalogue))
}

/// Settings for `run`: a bad `categories.toml` must not stop recording (a typo in a cosmetic file cannot open a
/// hole in the day), so it falls back to the built-in categories and returns the problem to log and record.
pub fn load_run_settings(dir: &std::path::Path) -> Result<(Config, categories::Catalogue, Option<String>), String> {
    let cfg = load_config(dir)?;
    let (file, problem) = categories::load_or_default(&dir.join("categories.toml"));
    let catalogue = categories::Catalogue::with_file(&file, &cfg.extra_games);
    Ok((cfg, catalogue, problem))
}

fn cmd_config(args: &[String]) -> Result<(), String> {
    let d = dir()?;
    let path = d.join("config.toml");
    match args.first().map(String::as_str) {
        Some("path") => {
            println!("{}", path.display());
            Ok(())
        }
        Some("init") => {
            if path.exists() {
                return Err(format!("{} already exists; edit it, or delete it to start again", path.display()));
            }
            std::fs::write(&path, config::TEMPLATE).map_err(|e| e.to_string())?;
            println!("wrote {}", path.display());
            Ok(())
        }
        Some("show") => {
            print!("{}", config::show(&Config::load(&path)?));
            Ok(())
        }
        Some("set") => match (args.get(1), args.get(2)) {
            (Some(key), Some(value)) if args.len() == 3 => {
                println!("{}", config::set_and_write(&path, key, value)?);
                Ok(())
            }
            _ => Err("usage: rhen-watch config set KEY VALUE (see `rhen-watch config show` for the keys)".into()),
        },
        _ => Err("usage: rhen-watch config init|path|show|set".into()),
    }
}

fn cmd_categories(args: &[String]) -> Result<(), String> {
    let d = dir()?;
    let path = d.join("categories.toml");
    match args.first().map(String::as_str) {
        Some("path") => {
            println!("{}", path.display());
            Ok(())
        }
        Some("init") if args.iter().any(|a| a == "--from-config") => {
            let text = config::read_text(&d.join("config.toml"), "config.toml")?.unwrap_or_default();
            // Printed, never written: the user saves it, so neither file is rewritten behind their back.
            print!("{}", categories::migrate_from_config(&text)?);
            Ok(())
        }
        Some("init") => {
            if path.exists() {
                return Err(format!("{} already exists; edit it, or delete it to start again", path.display()));
            }
            std::fs::write(&path, categories::init_text()).map_err(|e| e.to_string())?;
            println!("wrote {}", path.display());
            Ok(())
        }
        Some("set") => match (args.get(1), args.get(2)) {
            (Some(exe), Some(category)) if args.len() == 3 => {
                let existing = config::read_text(&path, "categories.toml")?;
                let (text, warnings) = categories::set_entry(existing.as_deref(), exe, category)?;
                let tmp = path.with_extension("toml.tmp");
                std::fs::write(&tmp, &text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
                if let Err(e) = std::fs::rename(&tmp, &path) {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(format!("cannot replace {}: {e}", path.display()));
                }
                for w in warnings {
                    crate::log::warn(&w);
                }
                println!(
                    "{} = {category}; takes effect when the agent restarts, and in the next report",
                    exe.to_ascii_lowercase()
                );
                Ok(())
            }
            _ => Err("usage: rhen-watch categories set EXE CATEGORY (for example: categories set foo.exe editor)".into()),
        },
        Some("list") => {
            let file = CategoryFile::load(&path)?;
            let cat = categories::Catalogue::with_file(&file, &[]);
            if args.iter().any(|a| a == "--uncategorised") {
                let db = d.join("activity.db");
                if !db.exists() {
                    return Err("no database yet; run `rhen-watch run` first".into());
                }
                let store = store::Store::open_read_only(&db).map_err(|e| e.to_string())?;
                let totals = store.app_time_totals().map_err(|e| e.to_string())?;
                let list = categories::uncategorised(&totals, &cat, 15);
                if list.is_empty() {
                    println!("Every app seen so far has a category.");
                }
                for (exe, ms) in list {
                    println!("{exe:<28} {:>8}   {}", report::fmt_duration(ms), categories::paste_line(&exe));
                }
            } else {
                for (exe, category, source) in cat.entries(&file) {
                    println!("{exe:<28} {category:<10} {:<8} {source}", cat.group_of_category(&category));
                }
            }
            Ok(())
        }
        _ => Err("usage: rhen-watch categories init [--from-config]|path|list [--uncategorised]|set EXE CATEGORY".into()),
    }
}

fn cmd_wipe(args: &[String]) -> Result<(), String> {
    if !args.iter().any(|a| a == "--yes") {
        return Err(format!(
            "this deletes the database, config and log files rhen-watch keeps in {}; run again with --yes",
            paths::data_dir()?.display()
        ));
    }
    wipe(false)
}

/// Delete what rhen-watch keeps; `remove_dir` (purge) also removes the data folder when nothing else is in it.
/// Console output only: the log file is among the things deleted.
fn wipe(remove_dir: bool) -> Result<(), String> {
    for p in crate::handover::wipe_files(&paths::data_dir()?, remove_dir)? {
        println!("deleted {}", p.display());
    }
    Ok(())
}

fn cmd_export(args: &[String]) -> Result<(), String> {
    let [dest] = args else {
        return Err("usage: rhen-watch export PATH (a new file; an existing one is never overwritten)".into());
    };
    let size = crate::handover::export_db(&dir()?.join("activity.db"), std::path::Path::new(dest))?;
    let path = std::fs::canonicalize(dest).unwrap_or_else(|_| PathBuf::from(dest));
    println!("{} ({:.2} MB)", path.display(), size as f64 / 1_048_576.0);
    Ok(())
}

/// True while an agent holds `run.lock` (the OS drops it if the process dies).
pub fn agent_running(dir: &std::path::Path) -> bool {
    match std::fs::OpenOptions::new().write(true).open(dir.join("run.lock")) {
        Ok(f) => matches!(f.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
        Err(_) => false,
    }
}

fn cmd_status() -> Result<(), String> {
    let d = dir()?;
    println!("data directory: {}", d.display());
    println!("agent: {}", if agent_running(&d) { "running" } else { "not running" });
    let db = d.join("activity.db");
    if !db.exists() {
        println!("no database yet; run `rhen-watch run`");
        return Ok(());
    }
    let store = store::Store::open(&db).map_err(|e| e.to_string())?;
    println!(
        "database: {:.2} MB, {} events",
        store.db_bytes() as f64 / 1_048_576.0,
        store.count_events().map_err(|e| e.to_string())?
    );
    match store.last_heartbeat().map_err(|e| e.to_string())? {
        Some(t) => println!("last heartbeat: {} s ago", (now_ms() - t) / 1000),
        None => println!("no heartbeat recorded"),
    }
    println!("open intervals: {}", store.open_rows().len());
    Ok(())
}

pub fn now_ms() -> Ms {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as Ms)
        .unwrap_or(0)
}

/// The user's time zone: per-instant offsets on Windows, UTC elsewhere.
pub(crate) fn local_tz() -> TzOffset {
    #[cfg(windows)]
    {
        platform::windows::local_tz()
    }
    #[cfg(not(windows))]
    {
        TzOffset::fixed(0)
    }
}

/// Days since 1970-01-01 for a civil date (proleptic Gregorian).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-11-06` as a local day number.
pub fn parse_day(v: &str) -> Result<i64, String> {
    let parts: Vec<i64> = v.split('-').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 3 || !(1..=12).contains(&parts[1]) || !(1..=31).contains(&parts[2]) {
        return Err("--day must look like 2026-11-06".into());
    }
    Ok(days_from_civil(parts[0], parts[1], parts[2]))
}

/// The days from `from` to `to`, both included.
pub fn day_range(from: &str, to: &str) -> Result<Vec<i64>, String> {
    let (a, b) = (
        parse_day(from).map_err(|_| "--from must look like 2026-11-06")?,
        parse_day(to).map_err(|_| "--to must look like 2026-11-09")?,
    );
    if b < a {
        return Err("--from must not be later than --to".into());
    }
    if b - a >= 366 {
        return Err("--from and --to can span at most 366 days".into());
    }
    Ok((a..=b).collect())
}

/// One report per local day. Several days each get a `==== YYYY-MM-DD ====` heading; a single day prints as before.
pub fn report_days(
    store: &store::Store,
    cfg: &Config,
    catalogue: &categories::Catalogue,
    tz: &TzOffset,
    now: Ms,
    days: &[i64],
) -> Result<String, String> {
    let open_until = store.last_heartbeat().map_err(|e| e.to_string())?.unwrap_or(now).min(now);
    let params = crate::derive::Params::from(&cfg.derive);
    let mut out = String::new();
    for &day in days {
        let (from, to) = tz.day_window(day);
        let (y, m, dd) = civil_from_days(day);
        let label = format!("{y:04}-{m:02}-{dd:02}");
        if days.len() > 1 {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!("==== {label} ====\n"));
        }
        out.push_str(&report::build(
            store,
            &report::ReportInput {
                label: &label,
                from,
                to,
                open_until,
                tz: tz.clone(),
                catalogue,
                params: &params,
                idle_collector: cfg.collectors.idle,
            },
        )?);
    }
    Ok(out)
}

fn cmd_report(args: &[String]) -> Result<(), String> {
    let d = dir()?;
    // Settings first: a leftover [categories] table or a bad categories.toml is the more useful thing to hear.
    let (cfg, catalogue) = load_report_settings(&d)?;
    let db = d.join("activity.db");
    if !db.exists() {
        return Err("no database yet; run `rhen-watch run` first".into());
    }
    // A fixed offset overrides the zone; otherwise each end of the day gets its own offset.
    let tz = match flag_value(args, "--utc-offset-minutes")? {
        Some(v) => TzOffset::fixed(v.parse().map_err(|_| "--utc-offset-minutes must be a whole number".to_string())?),
        None => local_tz(),
    };
    let now = now_ms();
    let days = match (flag_value(args, "--day")?, flag_value(args, "--from")?, flag_value(args, "--to")?) {
        (Some(_), Some(_), _) | (Some(_), _, Some(_)) => return Err("use --day, or --from with --to, not both".into()),
        (Some(v), None, None) => vec![parse_day(v)?],
        (None, Some(from), Some(to)) => day_range(from, to)?,
        (None, Some(_), None) | (None, None, Some(_)) => return Err("--from and --to go together".into()),
        (None, None, None) => vec![tz.day_of(now)],
    };
    let store = store::Store::open_read_only(&db).map_err(|e| e.to_string())?;
    print!("{}", report_days(&store, &cfg, &catalogue, &tz, now, &days)?);
    Ok(())
}

#[cfg(not(windows))]
fn cmd_stop() -> Result<(), String> {
    Err("rhen-watch records on Windows only in this version".into())
}

#[cfg(not(windows))]
fn cmd_run(_args: &[String]) -> Result<(), String> {
    Err("rhen-watch records on Windows only in this version (report, status and config work anywhere)".into())
}

#[cfg(windows)]
fn cmd_stop() -> Result<(), String> {
    if platform::windows::signal_stop() {
        println!("stop requested; the agent flushes and exits within a few seconds");
        Ok(())
    } else {
        Err("no running agent found in this logon session".into())
    }
}

#[cfg(windows)]
fn cmd_run(args: &[String]) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    use platform::windows as win;

    if win::in_session_zero() {
        return Err("refusing to run in session 0 (a service); run it as the logged-in user".into());
    }
    let limit = match flag_value(args, "--for")? {
        Some(v) => Some(Duration::from_secs(
            v.parse().map_err(|_| "--for needs a number of seconds".to_string())?,
        )),
        None => None,
    };
    let d = dir()?;
    if let Err(e) = win::restrict_dir(&d) {
        crate::log::warn(&format!("could not restrict the data directory to your user: {e}"));
    }
    if d.to_string_lossy().starts_with("\\\\") {
        crate::log::warn("the data directory is on a network share; SQLite write-ahead logging is unsafe there");
    }
    // A leftover [categories] table in config.toml stops the agent; a bad categories.toml does not.
    let (cfg, catalogue, category_error) = load_run_settings(&d)?;

    // One agent per data directory. The OS drops the lock if the process dies.
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(d.join("run.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock()
        .map_err(|_| "another rhen-watch is already running (use `rhen-watch stop`)".to_string())?;

    let stop_event = win::StopEvent::create()?;
    win::install_ctrl_handler();
    win::set_data_dir(&d);

    let mut store = store::Store::open(&d.join("activity.db")).map_err(|e| e.to_string())?;
    store.set_tz(local_tz());
    let device = match store.meta("device").map_err(|e| e.to_string())? {
        Some(v) => v,
        None => {
            let v = ids::device_id();
            store.set_meta("device", &v).map_err(|e| e.to_string())?;
            v
        }
    };
    if let Some((from, to)) = store.recover(&device, now_ms()).map_err(|e| e.to_string())? {
        println!(
            "previous run ended without a clean stop; {} s recorded as unknown",
            (to - from) / 1000
        );
    }
    for category in catalogue.groupless() {
        crate::log::warn(&format!(
            "category \"{category}\" has no group, so it counts as other (add it under [group] in categories.toml)"
        ));
    }
    let settings = engine::Settings {
        idle_threshold_ms: cfg.idle_threshold_secs.unwrap_or(120).saturating_mul(1000),
        foreground: cfg.collectors.foreground,
        idle: cfg.collectors.idle,
        session: cfg.collectors.session,
        power: cfg.collectors.power,
        ..Default::default()
    };
    let engine = engine::Engine::new(settings, catalogue, ids::generator(now_ms));
    let dropped = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut run = runner::Runner::new(win::WinSys, engine, store, device, dropped.clone(), cfg.clone());

    let (tx, rx) = std::sync::mpsc::sync_channel::<runner::Raw>(1024);
    let (mut hooks, missing) = win::Hooks::start(tx, cfg.collectors.foreground, cfg.collectors.session, cfg.collectors.power)?;
    crate::log::info(&format!(
        "rhen-watch recording to {} (Ctrl+C or `rhen-watch stop` to end)",
        d.display()
    ));

    let started = Instant::now();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
        run.start()?;
        if let Some(e) = &category_error {
            crate::log::warn(&format!("{e}; recording with the built-in categories"));
            run.degraded(&["categories.toml".to_string()])?;
        }
        if !missing.is_empty() {
            crate::log::warn(&format!("could not register for: {} (recorded as degraded)", missing.join(", ")));
            run.degraded(&missing)?;
        }
        loop {
            if win::STOP.load(Ordering::SeqCst) || stop_event.signalled() || limit.is_some_and(|l| started.elapsed() >= l) {
                return Ok(());
            }
            match rx.recv_timeout(Duration::from_millis(1000)) {
                Ok(raw) => run.handle(raw)?,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("the hook thread ended".into());
                }
            }
            // Mirror the hook thread's drop counter into the runner's.
            dropped.store(win::DROPPED.load(Ordering::Relaxed), Ordering::Relaxed);
            run.tick()?;
            win::set_state(run.state());
        }
    }));
    // Whatever happened, close what is open so the report shows an honest end. This comes before the hooks
    // are torn down so a console close or logoff handler waiting on `STOPPED` is released as early as possible.
    let stopped = run.stop();
    win::STOPPED.store(true, Ordering::SeqCst);
    hooks.stop();
    match result {
        Ok(Ok(())) => stopped,
        Ok(Err(e)) => Err(e),
        Err(_) => Err("internal error (panic); the open intervals were closed".into()),
    }
}

#[cfg(not(windows))]
fn cmd_install() -> Result<(), String> {
    Err("install is for Windows".into())
}

#[cfg(not(windows))]
fn cmd_uninstall(_args: &[String]) -> Result<(), String> {
    Err("uninstall is for Windows".into())
}

#[cfg(windows)]
fn install_dir() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(|d| PathBuf::from(d).join("Programs").join("rhen-watch"))
        .ok_or_else(|| "LOCALAPPDATA is not set".to_string())
}

/// Wait until none of `files` is held open by a running copy (Windows will not replace or delete a running program).
#[cfg(windows)]
fn wait_released(files: &[PathBuf]) -> Result<(), String> {
    use std::time::{Duration, Instant};
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
#[cfg(windows)]
fn stop_and_wait() -> Result<(), String> {
    use std::time::{Duration, Instant};
    if !platform::windows::signal_stop() {
        return Ok(());
    }
    let lock = paths::data_dir()?.join("run.lock");
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

#[cfg(windows)]
fn cmd_install() -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let here = std::env::current_exe().map_err(|e| e.to_string())?;
    let src_dir = here.parent().ok_or("cannot find the folder this program is in")?.to_path_buf();
    let dest = install_dir()?;
    let names = ["rhen-watch.exe", "rhen-watchw.exe"];
    for n in names {
        if !src_dir.join(n).exists() {
            return Err(format!(
                "{n} must sit next to this program to install it (looked in {})",
                src_dir.display()
            ));
        }
    }
    stop_and_wait()?;
    std::fs::create_dir_all(&dest).map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
    let same = match (src_dir.canonicalize(), dest.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if !same {
        let targets: Vec<PathBuf> = names.iter().map(|n| dest.join(n)).collect();
        wait_released(&targets)?;
        // Copy both under temporary names first, so a failure leaves the old pair untouched.
        let staged: Vec<(PathBuf, PathBuf)> = names.iter().map(|n| (dest.join(format!("{n}.new")), dest.join(n))).collect();
        for (n, (tmp, _)) in names.iter().zip(&staged) {
            if let Err(e) = std::fs::copy(src_dir.join(n), tmp) {
                for (t, _) in &staged {
                    let _ = std::fs::remove_file(t);
                }
                return Err(format!("cannot copy {n}: {e}"));
            }
        }
        for (tmp, target) in &staged {
            std::fs::rename(tmp, target).map_err(|e| format!("cannot replace {}: {e}", target.display()))?;
        }
    }
    let gui = dest.join("rhen-watchw.exe");
    platform::windows::set_autostart(&format!("\"{}\" run", gui.display()))?;
    // DETACHED_PROCESS | CREATE_NO_WINDOW: the agent outlives this console and shows no window of its own.
    let mut child = std::process::Command::new(&gui)
        .arg("run")
        .creation_flags(0x0000_0008 | 0x0800_0000)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("installed, but could not start it: {e}"))?;
    // Prove it is alive: it holds run.lock once it is recording, and it must not have exited.
    let data = paths::data_dir()?;
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "installed, but the agent exited at once ({status}); see rhen-watch.log in {}",
                data.display()
            ));
        }
        if agent_running(&data) {
            break;
        }
        if started.elapsed() > std::time::Duration::from_secs(5) {
            return Err(format!(
                "installed, but the agent did not start recording within 5 seconds; see rhen-watch.log in {}",
                data.display()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    crate::log::info(&format!("installed to {}", dest.display()));
    println!("It starts when you log on and is running now (look for the tray icon).");
    println!("Report:    {}\\rhen-watch.exe report", dest.display());
    println!("Stop:      {}\\rhen-watch.exe stop", dest.display());
    println!(
        "Uninstall: {}\\rhen-watch.exe uninstall   (add --purge to delete your data too)",
        dest.display()
    );
    Ok(())
}

#[cfg(windows)]
fn cmd_uninstall(args: &[String]) -> Result<(), String> {
    let dest = install_dir()?;
    stop_and_wait()?;
    let gui = dest.join("rhen-watchw.exe");
    wait_released(&[gui])?;
    platform::windows::clear_autostart()?;
    let mut leftovers = Vec::new();
    for n in ["rhen-watch.exe", "rhen-watchw.exe"] {
        let p = dest.join(n);
        if p.exists() {
            // The console copy may be the program running this very command; Windows will not delete it.
            if std::env::current_exe().ok().and_then(|me| me.canonicalize().ok()) == p.canonicalize().ok() {
                leftovers.push(p);
            } else if let Err(e) = std::fs::remove_file(&p) {
                return Err(format!("cannot remove {}: {e}", p.display()));
            }
        }
    }
    if leftovers.is_empty() {
        let _ = std::fs::remove_dir(&dest);
    } else {
        println!(
            "Delete {} yourself when this window closes (a program cannot delete itself).",
            dest.display()
        );
    }
    if args.iter().any(|a| a == "--purge") {
        wipe(true)?;
    } else {
        println!("Your data is kept in {}; add --purge to delete it.", paths::data_dir()?.display());
    }
    println!("Uninstalled.");
    Ok(())
}
