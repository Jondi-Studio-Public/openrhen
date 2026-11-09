//! What the command line says about a bad config, an old database and a failed start. Pure helpers, any OS.

use crate::cli;
use crate::store::Store;

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rhen-watch-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const LEGACY: &str = "[categories]\n\"x.exe\" = \"editor\"\n";

#[test]
fn status_says_a_bad_config_stops_the_agent() {
    let dir = temp("status-bad");
    std::fs::write(dir.join("config.toml"), "idle_treshold_secs = 1\n").unwrap();
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("settings: ERROR"), "{text}");
    assert!(text.contains("idle_treshold_secs"), "{text}");
    assert!(text.contains("(the agent will not start)"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn status_says_a_legacy_categories_table_stops_the_agent() {
    let dir = temp("status-legacy");
    std::fs::write(dir.join("config.toml"), LEGACY).unwrap();
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("settings: ERROR") && text.contains("categories.toml"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn status_says_ok_for_good_settings_and_names_a_bad_categories_file() {
    let dir = temp("status-ok");
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("settings: ok"), "{text}");
    std::fs::write(dir.join("categories.toml"), "[exe\n").unwrap();
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("settings: ok"), "{text}");
    assert!(text.contains("categories.toml") && text.contains("built-in categories"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn config_show_prints_the_settings_error_instead_of_failing() {
    let dir = temp("show-bad");
    std::fs::write(dir.join("config.toml"), "idle_threshold_secs = \"x\"\n").unwrap();
    let text = cli::config_show_text(&dir).unwrap();
    assert!(
        text.contains("settings: ERROR") && text.contains("(the agent will not start)"),
        "{text}"
    );
    std::fs::write(dir.join("config.toml"), LEGACY).unwrap();
    let text = cli::config_show_text(&dir).unwrap();
    assert!(text.contains("idle_threshold_secs"), "the settings are still listed: {text}");
    assert!(text.contains("settings: ERROR") && text.contains("categories.toml"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A file written the way a schema-1 build wrote it: no offset columns, version 1, no WAL.
fn write_schema_1_db(path: &std::path::Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE events (id TEXT PRIMARY KEY, device TEXT NOT NULL, ts_start INTEGER NOT NULL,
           ts_end INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, attrs TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE metrics (minute_ts INTEGER PRIMARY KEY, cpu_ms INTEGER NOT NULL, rss_bytes INTEGER NOT NULL,
           db_bytes INTEGER NOT NULL, events INTEGER NOT NULL, dropped INTEGER NOT NULL);
         CREATE TABLE input_buckets (minute_ts INTEGER NOT NULL, exe TEXT NOT NULL, run INTEGER NOT NULL,
           observed_ms INTEGER NOT NULL, input_ms INTEGER NOT NULL, PRIMARY KEY (minute_ts, exe, run)) WITHOUT ROWID;
         INSERT INTO meta VALUES ('schema_version', '1');
         INSERT INTO events (id, device, ts_start, ts_end, source, kind) VALUES ('e1', 'd', 1000, 2000, 'agent', 'start');",
    )
    .unwrap();
}

#[test]
fn status_leaves_a_real_schema_1_database_alone_and_shows_its_version() {
    let dir = temp("status-v1");
    let db = dir.join("activity.db");
    write_schema_1_db(&db);
    let before = std::fs::read(&db).unwrap();
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("schema version: 1"), "{text}");
    assert!(text.contains("1 events"), "{text}");
    assert_eq!(std::fs::read(&db).unwrap(), before, "status must not touch the file");
    let s = Store::open_read_only(&db).unwrap();
    assert_eq!(s.schema_version().unwrap(), Some(1), "status must not migrate");
    drop(s);
    // The agent's own open does migrate it.
    let s = Store::open(&db).unwrap();
    assert_eq!(s.schema_version().unwrap(), Some(2));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn status_works_on_a_newer_schema() {
    let dir = temp("status-v9");
    let db = dir.join("activity.db");
    {
        let s = Store::open(&db).unwrap();
        s.set_meta("schema_version", "9").unwrap();
    }
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("schema version: 9"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn install_refuses_a_config_the_agent_would_reject() {
    let dir = temp("install");
    assert!(cli::check_settings_for_install(&dir).is_ok());
    std::fs::write(dir.join("config.toml"), "[retention]\nevents = -3\n").unwrap();
    let err = cli::check_settings_for_install(&dir).unwrap_err();
    assert!(err.contains("config.toml"), "{err}");
    assert!(err.contains("nothing was installed"), "{err}");
    std::fs::write(dir.join("config.toml"), LEGACY).unwrap();
    assert!(cli::check_settings_for_install(&dir).unwrap_err().contains("categories.toml"));
    std::fs::write(dir.join("config.toml"), "").unwrap();
    std::fs::write(dir.join("categories.toml"), "[exe\n").unwrap();
    assert!(cli::check_settings_for_install(&dir).is_ok(), "a bad categories.toml only degrades");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_run_gets_a_message_box_but_a_duplicate_start_does_not() {
    let run = vec!["run".to_string()];
    assert_eq!(cli::error_box_title(&run, false, "boom"), Some("rhen-watch did not start"));
    assert_eq!(
        cli::error_box_title(&run, true, "cannot write to the database"),
        Some("rhen-watch stopped")
    );
    assert_eq!(cli::error_box_title(&run, false, cli::ALREADY_RUNNING), None);
    assert_eq!(
        cli::error_box_title(&run, false, &format!("{}boom", cli::REPEATED_REFUSAL)),
        None,
        "a repeated refusal is logged, not shown again"
    );
    assert_eq!(cli::error_box_title(&run, true, cli::ALREADY_RUNNING), None);
    assert_eq!(cli::error_box_title(&["status".to_string()], false, "boom"), None);
    assert_eq!(cli::error_box_title(&[], false, "boom"), None);
}

#[test]
fn status_prints_the_settings_lines_before_a_database_error() {
    let dir = temp("status-corrupt");
    std::fs::write(
        dir.join("activity.db"),
        b"this is not a database, just text padding to fill a page......",
    )
    .unwrap();
    let mut out = String::new();
    let result = cli::status_report(&dir, &mut out);
    assert!(result.is_err());
    assert!(out.contains("settings: ok") && out.contains("agent:"), "{out}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_a_held_lock_reads_as_a_duplicate_start() {
    let held = std::fs::TryLockError::WouldBlock;
    assert_eq!(cli::lock_error(held), cli::ALREADY_RUNNING);
    let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access is denied");
    let msg = cli::lock_error(std::fs::TryLockError::Error(io));
    assert_ne!(msg, cli::ALREADY_RUNNING);
    assert!(msg.contains("access is denied") && msg.contains("run.lock"), "{msg}");
    let run = vec!["run".to_string()];
    assert!(cli::error_box_title(&run, false, &msg).is_some(), "a real lock error shows the box");
}

#[test]
fn a_duplicate_start_is_not_a_refusal() {
    assert_eq!(cli::duplicate_start(true, cli::ALREADY_RUNNING), Some(Ok(())));
    assert_eq!(
        cli::duplicate_start(false, cli::ALREADY_RUNNING),
        Some(Err(cli::ALREADY_RUNNING.to_string()))
    );
    assert_eq!(cli::duplicate_start(false, "run.lock: access is denied"), None);
    assert_eq!(cli::duplicate_start(true, "run.lock: access is denied"), None);
}

#[test]
fn a_panic_outside_the_recording_loop_becomes_an_error() {
    let r = cli::guarded(|| -> Result<(), String> { panic!("store open blew up") });
    let e = r.unwrap_err();
    assert!(e.contains("internal error") && e.contains("rhen-watch.log"), "{e}");
    assert_eq!(cli::guarded(|| Ok(())), Ok(()));
    assert_eq!(cli::guarded(|| Err("plain".to_string())), Err("plain".to_string()));
}

#[test]
fn a_message_box_never_outlives_its_time_limit() {
    use std::time::{Duration, Instant};
    let t = Instant::now();
    let finished = cli::wait_at_most(Duration::from_millis(200), || std::thread::sleep(Duration::from_secs(30)));
    assert!(!finished && t.elapsed() < Duration::from_secs(5));
    assert!(cli::wait_at_most(Duration::from_secs(5), || {}));
}
