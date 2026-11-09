//! The UTC offset stored with each row (schema 2), so an uploader can send the local time each event had.

use rusqlite::Connection;
use serde_json::Map;

use crate::model::{Op, SRC_AGENT, SRC_FOREGROUND};
use crate::store::Store;
use crate::tz::TzOffset;

const MIN: i64 = 60_000;

fn tmp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rhen-watch-offset-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// +60 before 10 minutes, +120 from then on: a zone change while an interval is open.
fn shifting() -> TzOffset {
    TzOffset::from_fn(|t| if t < 10 * MIN { 60 } else { 120 })
}

fn open(id: &str, ts: i64) -> Op {
    Op::Open {
        id: id.into(),
        source: SRC_FOREGROUND,
        kind: "app".into(),
        ts,
        attrs: Map::new(),
    }
}

#[test]
fn an_interval_keeps_the_offset_it_opened_with() {
    let mut s = Store::in_memory().unwrap();
    s.set_tz(shifting());
    s.apply("d", &[open("a", 9 * MIN)], 9 * MIN).unwrap();
    s.apply(
        "d",
        &[Op::Close {
            id: "a".into(),
            ts: 11 * MIN,
        }],
        11 * MIN,
    )
    .unwrap();
    let (events, _) = s.raw_offsets_for_test();
    assert_eq!(events, vec![("app".to_string(), Some(60))]);
}

#[test]
fn an_open_interval_survives_a_restart_with_its_offset() {
    let dir = tmp("restart");
    let path = dir.join("a.db");
    {
        let mut s = Store::open(&path).unwrap();
        s.set_tz(shifting());
        s.apply("d", &[open("a", 9 * MIN)], 9 * MIN).unwrap();
    }
    let mut s = Store::open(&path).unwrap();
    assert_eq!(s.open_rows().len(), 1);
    s.apply(
        "d",
        &[Op::Close {
            id: "a".into(),
            ts: 11 * MIN,
        }],
        11 * MIN,
    )
    .unwrap();
    assert_eq!(s.raw_offsets_for_test().0, vec![("app".to_string(), Some(60))]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn open_state_saved_without_an_offset_still_loads() {
    let dir = tmp("old-state");
    let path = dir.join("a.db");
    {
        let s2 = Store::open(&path).unwrap();
        s2.set_meta(
            "open_state",
            r#"[{"id":"a","source":"foreground","kind":"app","ts_start":0,"attrs":{}}]"#,
        )
        .unwrap();
    }
    let mut s2 = Store::open(&path).unwrap();
    assert_eq!(s2.open_rows().len(), 1, "an old open_state is not thrown away");
    s2.apply("d", &[Op::Close { id: "a".into(), ts: MIN }], MIN).unwrap();
    assert_eq!(s2.raw_offsets_for_test().0, vec![("app".to_string(), None)]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_instant_and_a_bucket_get_the_offset_at_their_time() {
    let mut s = Store::in_memory().unwrap();
    s.set_tz(shifting());
    s.apply(
        "d",
        &[
            Op::Instant {
                source: SRC_AGENT,
                kind: "start".into(),
                ts: 12 * MIN,
                end: None,
                attrs: Map::new(),
            },
            Op::Bucket {
                minute_ts: 9 * MIN,
                exe: "code.exe".into(),
                run: 1,
                observed_ms: 1000,
                input_ms: 500,
            },
        ],
        12 * MIN,
    )
    .unwrap();
    // A later update of the same minute keeps the first offset.
    s.set_tz(TzOffset::fixed(0));
    s.apply(
        "d",
        &[Op::Bucket {
            minute_ts: 9 * MIN,
            exe: "code.exe".into(),
            run: 1,
            observed_ms: 2000,
            input_ms: 900,
        }],
        12 * MIN,
    )
    .unwrap();
    let (events, buckets) = s.raw_offsets_for_test();
    assert_eq!(events, vec![("start".to_string(), Some(120))]);
    assert_eq!(buckets, vec![("code.exe".to_string(), Some(60))]);
}

#[test]
fn a_time_long_before_the_write_gets_no_offset() {
    let mut s = Store::in_memory().unwrap();
    s.set_tz(TzOffset::fixed(780));
    s.apply("d", &[], 0).unwrap();
    // The agent was off for an hour: the gap row is written at the next start, so its offset is unknown.
    s.recover("d", 60 * MIN).unwrap();
    assert_eq!(s.raw_offsets_for_test().0, vec![("unknown".to_string(), None)]);
}

#[test]
fn a_time_just_ahead_of_the_write_is_fresh_and_one_far_ahead_is_not() {
    let mut s = Store::in_memory().unwrap();
    s.set_tz(TzOffset::fixed(60));
    let instant = |kind: &str, ts: i64| Op::Instant {
        source: SRC_AGENT,
        kind: kind.into(),
        ts,
        end: None,
        attrs: Map::new(),
    };
    s.apply(
        "d",
        &[instant("near", 20 * MIN + MIN), instant("far", 20 * MIN + 10 * MIN)],
        20 * MIN,
    )
    .unwrap();
    assert_eq!(
        s.raw_offsets_for_test().0,
        vec![("near".to_string(), Some(60)), ("far".to_string(), None)]
    );
}

#[test]
fn without_a_time_zone_no_offset_is_stored() {
    let mut s = Store::in_memory().unwrap();
    s.apply("d", &[open("a", 0)], 0).unwrap();
    s.apply("d", &[Op::Close { id: "a".into(), ts: MIN }], MIN).unwrap();
    assert_eq!(s.raw_offsets_for_test().0, vec![("app".to_string(), None)]);
}

#[test]
fn a_v1_file_gains_the_column_and_its_old_rows_keep_null() {
    let dir = tmp("v1");
    let path = dir.join("a.db");
    {
        // The v1 layout exactly as main's agent wrote it.
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE events (id TEXT PRIMARY KEY, device TEXT NOT NULL, ts_start INTEGER NOT NULL,
               ts_end INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, attrs TEXT NOT NULL DEFAULT '{}');
             CREATE TABLE metrics (minute_ts INTEGER PRIMARY KEY, cpu_ms INTEGER NOT NULL, rss_bytes INTEGER NOT NULL,
               db_bytes INTEGER NOT NULL, events INTEGER NOT NULL, dropped INTEGER NOT NULL);
             INSERT INTO meta VALUES ('schema_version', '1');
             INSERT INTO events VALUES ('old', 'd', 0, 60000, 'foreground', 'app', '{\"exe\":\"a.exe\"}');",
        )
        .unwrap();
    }
    {
        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), Some(2));
        s.set_tz(TzOffset::fixed(780));
        s.apply("d", &[open("new", 2 * MIN)], 2 * MIN).unwrap();
        s.apply(
            "d",
            &[Op::Close {
                id: "new".into(),
                ts: 3 * MIN,
            }],
            3 * MIN,
        )
        .unwrap();
        assert_eq!(
            s.raw_offsets_for_test().0,
            vec![("app".to_string(), None), ("app".to_string(), Some(780))]
        );
    }
    // Opening again is a no-op: the column is not added twice.
    let s = Store::open(&path).unwrap();
    assert_eq!(s.raw_offsets_for_test().0.len(), 2);
    let ro = Store::open_read_only(&path).unwrap();
    assert_eq!(ro.events_between(0, i64::MAX).unwrap().len(), 2, "the report still reads it");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_v2_file_from_before_the_column_gains_it() {
    let dir = tmp("v2-early");
    let path = dir.join("a.db");
    {
        let s = Store::open(&path).unwrap();
        drop(s);
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "ALTER TABLE events DROP COLUMN tz_offset_min;
             ALTER TABLE input_buckets DROP COLUMN tz_offset_min;",
        )
        .unwrap();
    }
    let mut s = Store::open(&path).unwrap();
    s.set_tz(TzOffset::fixed(-300));
    s.apply(
        "d",
        &[Op::Bucket {
            minute_ts: 0,
            exe: "x.exe".into(),
            run: 1,
            observed_ms: 1,
            input_ms: 1,
        }],
        0,
    )
    .unwrap();
    assert_eq!(s.raw_offsets_for_test().1, vec![("x.exe".to_string(), Some(-300))]);
    let _ = std::fs::remove_dir_all(&dir);
}
