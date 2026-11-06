#![cfg_attr(not(windows), allow(dead_code))]
//! rhen-watch: a local desktop activity recorder. Observation only; it sends nothing anywhere.

mod categories;
mod config;
mod engine;
mod ids;
mod model;
mod paths;
mod platform;
mod report;
mod retention;
mod runner;
mod store;
#[cfg(test)]
mod tests;

use std::path::PathBuf;

use config::Config;
use model::Ms;

const HELP: &str = "rhen-watch: local desktop activity recorder (observation only, nothing is sent anywhere)

USAGE
  rhen-watch run [--for SECONDS]     record until Ctrl+C, `rhen-watch stop`, or SECONDS have passed
  rhen-watch stop                    ask a running agent to stop and flush
  rhen-watch report [--day YYYY-MM-DD] [--utc-offset-minutes N]
  rhen-watch status                  paths, size, last heartbeat, row counts
  rhen-watch config init|path        write the default config / print its path
  rhen-watch wipe --yes              delete the database, its sidecar files and the config
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match real_main(&args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("rhen-watch: {e}");
            1
        }
    };
    std::process::exit(code);
}

fn real_main(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("run") => cmd_run(&args[1..]),
        Some("stop") => cmd_stop(),
        Some("report") => cmd_report(&args[1..]),
        Some("status") => cmd_status(),
        Some("config") => cmd_config(args.get(1).map(String::as_str)),
        Some("wipe") => cmd_wipe(&args[1..]),
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

fn load_config(dir: &std::path::Path) -> Result<Config, String> {
    Config::load(&dir.join("config.toml"))
}

fn cmd_config(sub: Option<&str>) -> Result<(), String> {
    let d = dir()?;
    let path = d.join("config.toml");
    match sub {
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
        _ => Err("usage: rhen-watch config init|path".into()),
    }
}

fn cmd_wipe(args: &[String]) -> Result<(), String> {
    if !args.iter().any(|a| a == "--yes") {
        return Err("this deletes everything rhen-watch recorded on this machine; run again with --yes".into());
    }
    let d = paths::data_dir()?;
    for name in ["activity.db", "activity.db-wal", "activity.db-shm", "config.toml", "run.lock"] {
        let p = d.join(name);
        match std::fs::remove_file(&p) {
            Ok(()) => println!("deleted {}", p.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "could not delete {}: {e} (is the agent running? use `rhen-watch stop` first)",
                    p.display()
                ));
            }
        }
    }
    Ok(())
}

fn cmd_status() -> Result<(), String> {
    let d = dir()?;
    println!("data directory: {}", d.display());
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

fn local_offset() -> i32 {
    #[cfg(windows)]
    {
        platform::windows::local_offset_minutes()
    }
    #[cfg(not(windows))]
    {
        0
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

fn cmd_report(args: &[String]) -> Result<(), String> {
    let d = dir()?;
    let db = d.join("activity.db");
    if !db.exists() {
        return Err("no database yet; run `rhen-watch run` first".into());
    }
    let offset: i32 = match flag_value(args, "--utc-offset-minutes")? {
        Some(v) => v.parse().map_err(|_| "--utc-offset-minutes must be a whole number".to_string())?,
        None => local_offset(),
    };
    let now = now_ms();
    let local_day = (now + i64::from(offset) * 60_000).div_euclid(86_400_000);
    let day = match flag_value(args, "--day")? {
        Some(v) => {
            let parts: Vec<i64> = v.split('-').filter_map(|p| p.parse().ok()).collect();
            if parts.len() != 3 || !(1..=12).contains(&parts[1]) || !(1..=31).contains(&parts[2]) {
                return Err("--day must look like 2026-11-06".into());
            }
            days_from_civil(parts[0], parts[1], parts[2])
        }
        None => local_day,
    };
    let from = day * 86_400_000 - i64::from(offset) * 60_000;
    let (y, m, dd) = civil_from_days(day);
    let label = format!("{y:04}-{m:02}-{dd:02}");
    let store = store::Store::open(&db).map_err(|e| e.to_string())?;
    let open_until = store.last_heartbeat().map_err(|e| e.to_string())?.unwrap_or(now).min(now);
    let text = report::build(
        &store,
        &report::ReportInput {
            label: &label,
            from,
            to: from + 86_400_000,
            open_until,
            offset_min: offset,
        },
    )?;
    print!("{text}");
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
    let _ = win::restrict_dir(&d).map_err(|e| eprintln!("warning: could not restrict the data directory to your user: {e}"));
    if d.to_string_lossy().starts_with("\\\\") {
        eprintln!("warning: the data directory is on a network share; SQLite write-ahead logging is unsafe there");
    }
    let cfg = load_config(&d)?;

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

    let mut store = store::Store::open(&d.join("activity.db")).map_err(|e| e.to_string())?;
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
    match retention::purge(&store, &cfg, now_ms()) {
        Ok((e, m)) if e + m > 0 => {
            println!("retention purge removed {e} events and {m} metric rows")
        }
        Ok(_) => {}
        Err(e) => return Err(e),
    }

    let catalogue = categories::Catalogue::new(&cfg.categories, &cfg.extra_games);
    let settings = engine::Settings {
        idle_threshold_ms: cfg.idle_threshold_secs.unwrap_or(120) * 1000,
        foreground: cfg.collectors.foreground,
        idle: cfg.collectors.idle,
        session: cfg.collectors.session,
        power: cfg.collectors.power,
        ..Default::default()
    };
    let engine = engine::Engine::new(settings, catalogue, ids::generator(now_ms));
    let dropped = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut run = runner::Runner::new(win::WinSys, engine, store, device, dropped.clone());

    let (tx, rx) = std::sync::mpsc::sync_channel::<runner::Raw>(1024);
    let mut hooks = win::Hooks::start(tx, cfg.collectors.foreground, cfg.collectors.session, cfg.collectors.power)?;
    println!("rhen-watch recording to {} (Ctrl+C or `rhen-watch stop` to end)", d.display());

    let started = Instant::now();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
        run.start()?;
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
        }
    }));
    hooks.stop();
    // Whatever happened, close what is open so the report shows an honest end.
    let stopped = run.stop();
    match result {
        Ok(Ok(())) => stopped,
        Ok(Err(e)) => Err(e),
        Err(_) => Err("internal error (panic); the open intervals were closed".into()),
    }
}
