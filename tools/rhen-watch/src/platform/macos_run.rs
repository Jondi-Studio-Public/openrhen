//! `rhen-watch run` on macOS. Interim glue: it mirrors the Windows `cmd_run` until the platform-neutral agent
//! loop is extracted (plan M0), after which this file shrinks to the macOS parts only.

use std::fs::OpenOptions;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::macos as mac;
use crate::cli::{dir, flag_value, load_run_settings, now_ms};
use crate::engine::PowerEvt;
use crate::runner::Raw;
use crate::{engine, ids, runner, store};

pub fn cmd_run(args: &[String]) -> Result<(), String> {
    if mac::is_root() {
        return Err("refusing to run as root; run it as the logged-in user".into());
    }
    let limit = match flag_value(args, "--for")? {
        Some(v) => Some(Duration::from_secs(
            v.parse().map_err(|_| "--for needs a number of seconds".to_string())?,
        )),
        None => None,
    };
    let d = dir()?;
    if let Err(e) = mac::restrict_dir(&d) {
        crate::log::warn(&format!("could not restrict the data directory to your user: {e}"));
    }
    // From a terminal an error is printed and the command exits; started at login (no terminal, no time limit)
    // the error stays on the menu bar until Quit, so the agent never vanishes silently.
    let interactive = unsafe { libc::isatty(2) } == 1;
    let stay_on_error = !interactive && limit.is_none();
    mac::install_signal_handlers();
    let (cfg, catalogue, category_error) = match load_run_settings(&d) {
        Ok(v) => v,
        Err(e) if stay_on_error => return show_error(&d, e),
        Err(e) => return Err(e),
    };
    let wanted = mac::Wanted {
        foreground: cfg.collectors.foreground,
        session: cfg.collectors.session,
        power: cfg.collectors.power,
    };
    let (tx, rx) = std::sync::mpsc::sync_channel::<Raw>(1024);
    let dir_for_agent = d.clone();
    mac::run_app(tx, &d, wanted, stay_on_error, move |missing| {
        let r = record(&dir_for_agent, cfg, catalogue, category_error, missing, rx, limit);
        if let Err(e) = &r {
            crate::log::error(e);
        }
        r
    })
}

/// Startup failed before recording: keep the menu bar item up with the reason.
fn show_error(d: &std::path::Path, e: String) -> Result<(), String> {
    crate::log::error(&e);
    let (tx, _rx) = std::sync::mpsc::sync_channel::<Raw>(1);
    let wanted = mac::Wanted {
        foreground: false,
        session: false,
        power: false,
    };
    mac::run_app(tx, d, wanted, true, move |_| Err(e))
}

fn record(
    d: &std::path::Path,
    cfg: crate::config::Config,
    catalogue: crate::categories::Catalogue,
    category_error: Option<String>,
    missing: Vec<String>,
    rx: std::sync::mpsc::Receiver<Raw>,
    limit: Option<Duration>,
) -> Result<(), String> {
    // One agent per data directory. The OS drops the lock if the process dies; the pid in it is how `stop`
    // finds this process.
    let mut lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(d.join("run.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock()
        .map_err(|_| "another rhen-watch is already running (use `rhen-watch stop`)".to_string())?;
    mac::write_pid(&mut lock)?;

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
        crate::log::info(&format!(
            "previous run ended without a clean stop; {} s recorded as unknown",
            (to - from) / 1000
        ));
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
    let dropped = Arc::new(AtomicU64::new(0));
    let mut run = runner::Runner::new(mac::MacSys, engine, store, device, dropped.clone(), cfg.clone());
    crate::log::info(&format!(
        "rhen-watch recording to {} (Ctrl+C, Quit in the menu bar, or `rhen-watch stop` to end)",
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
            if mac::STOP.load(Ordering::SeqCst) || limit.is_some_and(|l| started.elapsed() >= l) {
                return Ok(());
            }
            match rx.recv_timeout(Duration::from_millis(1000)) {
                Ok(raw) => {
                    let suspend = matches!(raw, Raw::Power(PowerEvt::Suspend));
                    run.handle(raw)?;
                    if suspend {
                        // The sleep callback is waiting for this before it lets the machine sleep.
                        mac::SUSPEND_ACK.fetch_add(1, Ordering::SeqCst);
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("the observers ended".into());
                }
            }
            dropped.store(mac::DROPPED.load(Ordering::Relaxed), Ordering::Relaxed);
            run.tick()?;
            mac::set_state(run.state());
        }
    }));
    // Whatever happened, close what is open so the report shows an honest end.
    let stopped = run.stop();
    match result {
        Ok(Ok(())) => stopped,
        Ok(Err(e)) => Err(e),
        Err(_) => Err("internal error (panic); the open intervals were closed".into()),
    }
}
