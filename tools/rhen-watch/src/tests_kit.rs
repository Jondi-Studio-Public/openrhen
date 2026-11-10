//! The test kit: `export`, `report --from/--to`, what `wipe` and `uninstall --purge` delete, readable log times.

use std::path::PathBuf;

use crate::categories::Catalogue;
use crate::cli::{day_range, days_from_civil, parse_day, report_days};
use crate::config::Config;
use crate::handover::{export_db, wipe_files};
use crate::log::stamp;
use crate::model::Op;
use crate::store::Store;
use crate::tz::TzOffset;

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rhen-watch-kit-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn start_op(ts: i64) -> Op {
    Op::Instant {
        source: "agent",
        kind: "start".into(),
        ts,
        end: None,
        attrs: Default::default(),
    }
}

// ---- RW-38: log times ----

#[test]
fn log_times_are_local_iso_with_the_offset() {
    let utc = days_from_civil(2026, 11, 9) * 86_400_000 + (3600 + 3 * 60 + 12) * 1000 + 345;
    assert_eq!(stamp(utc, 13 * 60), "2026-11-09T14:03:12+13:00");
    assert_eq!(stamp(utc, 0), "2026-11-09T01:03:12+00:00");
    assert_eq!(stamp(utc, -(3 * 60 + 30)), "2026-11-08T21:33:12-03:30");
    assert_eq!(stamp(0, 0), "1970-01-01T00:00:00+00:00");
}

// ---- RW-09: export ----

#[test]
fn export_writes_a_consistent_copy_while_the_database_is_open_and_refuses_to_overwrite() {
    let dir = tmp("export");
    let db = dir.join("activity.db");
    let mut live = Store::open(&db).unwrap();
    live.apply("d", &[start_op(1_000)], 1_000).unwrap();
    // `live` stays open, as a running agent would: its newest rows may still sit in the -wal file.
    let out = dir.join("copy.db");
    let size = export_db(&db, &out).unwrap();
    assert!(size > 0 && size == std::fs::metadata(&out).unwrap().len());
    let copy = Store::open_read_only(&out).unwrap();
    assert_eq!(copy.count_events().unwrap(), 1);
    let err = export_db(&db, &out).unwrap_err();
    assert!(err.contains("already exists"), "{err}");
    assert_eq!(Store::open_read_only(&out).unwrap().count_events().unwrap(), 1, "left as it was");
    assert!(export_db(&dir.join("missing.db"), &dir.join("x.db")).is_err());
    assert!(!dir.join("x.db").exists());
    drop(live);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- RW-09: several days ----

#[test]
fn a_day_range_is_inclusive_and_checked() {
    let a = days_from_civil(2026, 11, 7);
    assert_eq!(day_range("2026-11-07", "2026-11-09").unwrap(), vec![a, a + 1, a + 2]);
    assert_eq!(day_range("2026-11-07", "2026-11-07").unwrap(), vec![a]);
    assert!(day_range("2026-11-09", "2026-11-07").unwrap_err().contains("--from"));
    assert!(day_range("2026-11-07", "nope").unwrap_err().contains("--to"));
    assert!(day_range("2020-01-01", "2026-01-01").unwrap_err().contains("days"));
    assert_eq!(parse_day("2026-11-06").unwrap(), days_from_civil(2026, 11, 6));
    assert!(parse_day("2026-13-06").is_err());
}

#[test]
fn several_days_print_one_after_another_with_a_heading_each() {
    let mut store = Store::in_memory().unwrap();
    let day = days_from_civil(2026, 11, 8);
    let at = day * 86_400_000 + 3_600_000;
    store.apply("d", &[start_op(at)], at).unwrap();
    let cfg = Config::default();
    let cat = Catalogue::with_file(&Default::default(), &[]);
    let tz = TzOffset::fixed(0);
    let now = (day + 3) * 86_400_000;
    let text = report_days(&store, &cfg, &cat, &tz, now, &[day, day + 1]).unwrap();
    let a = text.find("==== 2026-11-08 ====").expect("first heading");
    let b = text.find("==== 2026-11-09 ====").expect("second heading");
    assert!(a < b);
    let (first, second) = text.split_at(b);
    assert!(!first.contains("Nothing was captured"), "the first day has the start row");
    assert!(second.contains("Nothing was captured"), "the second day has no rows");
    assert_eq!(text.matches("Activity for 2026-1").count(), 2);
    // One day alone prints no heading, as before.
    let one = report_days(&store, &cfg, &cat, &tz, now, &[day]).unwrap();
    assert!(!one.contains("===="));
}

// ---- RW-28: wipe ----

fn fill(dir: &std::path::Path, names: &[&str]) {
    for n in names {
        std::fs::write(dir.join(n), "x").unwrap();
    }
}

const ALL: [&str; 15] = [
    "activity.db",
    "activity.db-wal",
    "activity.db-shm",
    "config.toml",
    "categories.toml",
    "categories.toml.tmp",
    "run.lock",
    "rhen-watch.log",
    "rhen-watch.log.1",
    "restart-reason.txt",
    "not-starting.txt",
    "stopped-by-user.txt",
    "state.txt",
    "state.toml.tmp",
    "unrelated.txt",
];

#[test]
fn wipe_deletes_the_logs_too_and_keeps_the_folder() {
    let dir = tmp("wipe");
    fill(&dir, &ALL);
    let gone = wipe_files(&dir, false).unwrap();
    assert_eq!(gone.len(), 14);
    for n in &ALL[..14] {
        assert!(!dir.join(n).exists(), "{n} should be deleted");
    }
    assert!(dir.join("unrelated.txt").exists(), "files the user added stay");
    assert!(dir.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn purge_removes_the_folder_when_empty_and_keeps_it_when_not() {
    let empty = tmp("purge-empty");
    fill(&empty, &ALL[..14]);
    wipe_files(&empty, true).unwrap();
    assert!(!empty.exists(), "an empty data folder goes");

    let kept = tmp("purge-kept");
    fill(&kept, &ALL);
    wipe_files(&kept, true).unwrap();
    assert!(kept.join("unrelated.txt").exists());
    let _ = std::fs::remove_dir_all(&kept);

    // Nothing there at all is not an error.
    assert!(wipe_files(&empty, true).unwrap().is_empty());
}
