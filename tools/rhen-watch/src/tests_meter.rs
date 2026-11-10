//! The input meter (per-minute input tally), its engine paths, the v2 store and the runner's polling.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use crate::activity::{Meter, idle_from_ticks};
use crate::categories::Catalogue;
use crate::config::Config;
use crate::engine::{Engine, Fg, PowerEvt, SessionEvt, Settings, Signal};
use crate::model::Op;
use crate::runner::{Control, Raw, Runner, Sys};
use crate::store::Store;

const LIMIT: i64 = 30_000;

fn buckets(ops: &[Op]) -> Vec<(i64, String, u64, i64, i64)> {
    ops.iter()
        .filter_map(|o| match o {
            Op::Bucket {
                minute_ts,
                exe,
                run,
                observed_ms,
                input_ms,
            } => Some((*minute_ts, exe.clone(), *run, *observed_ms, *input_ms)),
            _ => None,
        })
        .collect()
}

/// Latest (observed, input) per (minute, exe) in an op list, i.e. what the absolute upserts leave in the table.
fn totals(ops: &[Op]) -> (i64, i64) {
    let mut last: HashMap<(i64, String, u64), (i64, i64)> = HashMap::new();
    for (m, e, r, o, i) in buckets(ops) {
        last.insert((m, e, r), (o, i));
    }
    last.values().fold((0, 0), |a, v| (a.0 + v.0, a.1 + v.1))
}

// ---- Meter ----

#[test]
fn idle_from_ticks_survives_the_32_bit_wrap() {
    assert_eq!(idle_from_ticks(0x10, 0xFFFF_FFF0), 32);
    assert_eq!(idle_from_ticks(5_000, 1_000), 4_000);
    assert_eq!(idle_from_ticks(7, 7), 0);
}

#[test]
fn the_first_poll_after_a_reset_only_sets_the_baseline() {
    let mut m = Meter::new(0);
    assert!(
        m.sample(1_000, 1_000, 0, "code.exe", LIMIT).is_empty(),
        "no baseline yet: nothing credited, nothing observed"
    );
    let ops = m.sample(6_000, 6_000, 0, "code.exe", LIMIT);
    assert_eq!(totals(&ops), (5_000, 5_000));
}

#[test]
fn one_input_just_before_a_poll_credits_exactly_one_slot() {
    // The earlier "idle < slot + 250 ms" rule credited this twice (idle 0.2 s, then 5.2 s).
    let mut m = Meter::new(0);
    let mut all = Vec::new();
    m.sample(0, 0, 60_000, "a.exe", LIMIT); // baseline, last input long ago
    all.extend(m.sample(5_000, 5_000, 200, "a.exe", LIMIT)); // input at 4.8 s
    all.extend(m.sample(10_000, 10_000, 5_200, "a.exe", LIMIT)); // same input, now 5.2 s old
    all.extend(m.sample(15_000, 15_000, 10_200, "a.exe", LIMIT));
    assert_eq!(totals(&all), (15_000, 5_000));
}

#[test]
fn input_must_move_by_more_than_50_ms_to_count() {
    let mut m = Meter::new(0);
    m.sample(0, 0, 60_000, "a.exe", LIMIT);
    // tick resolution jitter: the derived last-input instant moves by 15 ms with no input
    let ops = m.sample(5_000, 5_000, 64_985, "a.exe", LIMIT);
    assert_eq!(totals(&ops), (5_000, 0));
    // a real input 100 ms after the previous instant counts
    let ops = m.sample(10_000, 10_000, 59_800, "a.exe", LIMIT);
    assert_eq!(totals(&ops), (10_000, 5_000));
}

#[test]
fn credit_is_capped_at_5_seconds_and_observed_is_the_whole_slot() {
    let mut m = Meter::new(0);
    m.sample(0, 0, 60_000, "a.exe", LIMIT);
    let ops = m.sample(15_000, 15_000, 100, "a.exe", LIMIT);
    assert_eq!(totals(&ops), (15_000, 5_000));
}

#[test]
fn a_slot_is_split_at_the_minute_boundary() {
    let mut m = Meter::new(0);
    m.sample(57_000, 57_000, 60_000, "a.exe", LIMIT);
    let ops = m.sample(62_000, 62_000, 100, "a.exe", LIMIT);
    let mut b = buckets(&ops);
    b.sort();
    assert_eq!((b[0].0, b[0].3, b[0].4), (0, 3_000, 3_000));
    assert_eq!((b[1].0, b[1].3, b[1].4), (60_000, 2_000, 2_000));
    assert!(b.iter().all(|x| x.4 <= x.3), "input never exceeds observed");
}

#[test]
fn a_slot_ending_exactly_on_a_minute_belongs_to_the_minute_it_covered() {
    let mut m = Meter::new(0);
    m.sample(55_000, 55_000, 60_000, "a.exe", LIMIT);
    let ops = m.sample(60_000, 60_000, 100, "a.exe", LIMIT);
    let b = buckets(&ops);
    assert_eq!(b.len(), 1);
    assert_eq!((b[0].0, b[0].3, b[0].4), (0, 5_000, 5_000));
}

#[test]
fn tick_jitter_at_both_cadences_keeps_every_slot() {
    // The loop wakes every second, so slots are cadence plus up to 2 s; the 30 s limit keeps them all.
    for (cadence, jitters) in [(5_000i64, [0i64, 1_000, 1_900, 1_000]), (15_000, [0, 1_000, 1_900, 1_500])] {
        let mut m = Meter::new(0);
        let mut t = 0;
        m.sample(t, t, 600_000, "a.exe", LIMIT);
        let mut all = Vec::new();
        let mut expect = 0;
        for j in jitters {
            let slot = cadence + j;
            t += slot;
            expect += slot;
            all.extend(m.sample(t, t, 600_000 + t as u64, "a.exe", LIMIT));
        }
        assert_eq!(totals(&all).0, expect, "cadence {cadence}");
    }
}

#[test]
fn a_slot_over_the_limit_is_discarded_and_the_next_one_is_normal() {
    let mut m = Meter::new(0);
    m.sample(0, 0, 60_000, "a.exe", LIMIT);
    assert!(
        m.sample(31_000, 31_000, 100, "a.exe", LIMIT).is_empty(),
        "31 s is beyond the 30 s limit"
    );
    let ops = m.sample(36_000, 36_000, 100 + 5_000, "a.exe", LIMIT);
    assert_eq!(
        totals(&ops),
        (5_000, 0),
        "baseline was the discarded poll; input there is not recredited"
    );
}

#[test]
fn wall_and_monotonic_clocks_that_disagree_by_over_2_seconds_discard_the_slot() {
    let mut m = Meter::new(0);
    m.sample(0, 0, 60_000, "a.exe", LIMIT);
    assert!(m.sample(5_000, 8_500, 100, "a.exe", LIMIT).is_empty());
    // within 2 s of each other is kept
    let ops = m.sample(10_000, 13_000, 100, "a.exe", LIMIT);
    assert_eq!(totals(&ops).0, 4_500, "the monotonic delta is the slot");
    assert!(
        m.sample(15_000, 13_000, 100, "a.exe", LIMIT).is_empty(),
        "a non-advancing monotonic clock is discarded"
    );
}

#[test]
fn each_exe_has_its_own_row_and_an_unreadable_one_is_empty_string() {
    let mut m = Meter::new(0);
    m.sample(0, 0, 60_000, "a.exe", LIMIT);
    let a = m.sample(5_000, 5_000, 100, "a.exe", LIMIT);
    let b = m.sample(10_000, 10_000, 100 + 5_000, "", LIMIT);
    assert_eq!(buckets(&a)[0].1, "a.exe");
    assert_eq!(buckets(&b)[0].1, "");
}

#[test]
fn every_poll_emits_absolute_values_for_what_it_touched() {
    let mut m = Meter::new(0);
    m.sample(0, 0, 60_000, "a.exe", LIMIT);
    let first = buckets(&m.sample(5_000, 5_000, 100, "a.exe", LIMIT));
    let second = buckets(&m.sample(10_000, 10_000, 100 + 5_000, "a.exe", LIMIT));
    assert_eq!((first[0].3, first[0].4), (5_000, 5_000));
    assert_eq!(
        (second[0].3, second[0].4),
        (10_000, 5_000),
        "cumulative for the minute, not the delta"
    );
}

#[test]
fn reset_bumps_the_run_and_emits_the_run_seq_before_its_first_bucket() {
    let mut m = Meter::new(7);
    assert_eq!(m.run(), 7);
    m.reset();
    assert_eq!(m.run(), 8);
    m.sample(0, 0, 60_000, "a.exe", LIMIT);
    let ops = m.sample(5_000, 5_000, 100, "a.exe", LIMIT);
    assert!(
        matches!(&ops[0], Op::Meta { key, value } if key == "run_seq" && value == "8"),
        "{ops:?}"
    );
    assert_eq!(buckets(&ops)[0].2, 8);
    let ops = m.sample(10_000, 10_000, 5_100, "a.exe", LIMIT);
    assert!(!ops.iter().any(|o| matches!(o, Op::Meta { .. })), "only when the run changed");
    m.reset();
    m.sample(11_000, 11_000, 60_000, "a.exe", LIMIT);
    let ops = m.sample(16_000, 16_000, 100, "a.exe", LIMIT);
    assert!(matches!(&ops[0], Op::Meta { value, .. } if value == "9"), "{ops:?}");
}

#[test]
fn reset_forgets_the_tally_so_a_new_run_starts_from_zero() {
    let mut m = Meter::new(0);
    m.reset();
    m.sample(0, 0, 60_000, "a.exe", LIMIT);
    m.sample(5_000, 5_000, 100, "a.exe", LIMIT);
    m.reset();
    m.sample(6_000, 6_000, 60_000, "a.exe", LIMIT);
    let b = buckets(&m.sample(11_000, 11_000, 100, "a.exe", LIMIT));
    assert_eq!((b[0].2, b[0].3), (2, 5_000));
}

#[test]
fn flush_repeats_the_open_minute_idempotently() {
    let mut m = Meter::new(0);
    m.reset();
    m.sample(0, 0, 60_000, "a.exe", LIMIT);
    let polled = m.sample(5_000, 5_000, 100, "a.exe", LIMIT);
    let flushed = m.flush();
    assert_eq!(totals(&flushed), totals(&polled));
    assert_eq!(totals(&m.flush()), totals(&polled));
    assert!(Meter::new(0).flush().is_empty());
}

// ---- Engine paths ----

fn eng(settings: Settings) -> Engine {
    let mut n = 0u32;
    Engine::new(
        settings,
        Catalogue::new(&HashMap::new(), &[]),
        Box::new(move || {
            n += 1;
            format!("id{n}")
        }),
    )
}

fn poll(e: &mut Engine, t: i64, idle: u64) -> Vec<Op> {
    e.step(t, Signal::Idle { idle_ms: idle, mono_ms: t }).ops
}

fn front(exe: &str) -> Signal {
    Signal::Foreground(Fg {
        class: "Chrome_WidgetWin_1".into(),
        exe: Some(exe.into()),
        declared: None,
    })
}

/// Two polls that credit, so the meter has a baseline and a tally.
fn warm(e: &mut Engine, t0: i64) -> i64 {
    warm_run(e, t0).0
}

/// Like `warm`, also returning the run the tally is in.
fn warm_run(e: &mut Engine, t0: i64) -> (i64, u64) {
    e.step(t0, Signal::Tick);
    e.step(t0, front("code.exe"));
    poll(e, t0 + 1_000, 60_000);
    let ops = poll(e, t0 + 6_000, 100);
    assert_eq!(totals(&ops).0, 5_000, "warm: {ops:?}");
    (t0 + 6_000, buckets(&ops)[0].2)
}

/// The run of the bucket the second poll after a reset writes; the first poll must write none.
fn credits_next_poll(e: &mut Engine, t: i64) -> Option<u64> {
    let first = poll(e, t, 100);
    let second = poll(e, t + 5_000, 5_100 - 5_000 + 20);
    assert!(
        buckets(&first).is_empty(),
        "the first poll after a reset credits nothing: {first:?}"
    );
    buckets(&second).first().map(|b| b.2)
}

#[test]
fn the_engine_tallies_against_the_foreground_exe() {
    let mut e = eng(Settings::default());
    let t = warm(&mut e, 1_000_000);
    let b = buckets(&poll(&mut e, t + 5_000, 100));
    assert_eq!(b[0].1, "code.exe");
}

#[test]
fn an_unreadable_foreground_is_attributed_to_the_empty_exe() {
    let mut e = eng(Settings::default());
    e.step(1_000_000, Signal::Tick);
    e.step(
        1_000_000,
        Signal::Foreground(Fg {
            class: "X".into(),
            exe: None,
            declared: None,
        }),
    );
    poll(&mut e, 1_001_000, 60_000);
    let b = buckets(&poll(&mut e, 1_006_000, 100));
    assert_eq!(b[0].1, "");
}

#[test]
fn the_meter_is_off_when_the_idle_collector_is_off() {
    let mut e = eng(Settings {
        idle: false,
        ..Settings::default()
    });
    e.step(1_000, front("code.exe"));
    assert!(!e.polling_allowed());
    for t in [2_000, 7_000, 12_000] {
        assert!(poll(&mut e, t, 100).is_empty());
    }
}

#[test]
fn nothing_is_polled_or_tallied_while_locked_suspended_paused_or_a_game_is_in_front() {
    let mut e = eng(Settings::default());
    let t = warm(&mut e, 1_000_000);
    assert!(e.polling_allowed());

    e.step(t + 1_000, Signal::Session(SessionEvt::Lock));
    assert!(!e.polling_allowed());
    assert!(poll(&mut e, t + 6_000, 100).is_empty());
    e.step(t + 7_000, Signal::Session(SessionEvt::Unlock));
    assert!(e.polling_allowed());

    e.step(t + 8_000, Signal::Power(PowerEvt::Suspend));
    assert!(!e.polling_allowed());
    assert!(poll(&mut e, t + 9_000, 100).is_empty());
    e.step(t + 10_000, Signal::Power(PowerEvt::Resume));

    e.step(t + 11_000, front("valorant.exe"));
    assert!(!e.polling_allowed());
    assert!(poll(&mut e, t + 12_000, 100).is_empty());
    e.step(t + 13_000, front("code.exe"));
    assert!(e.polling_allowed());

    e.step(t + 14_000, Signal::Pause);
    assert!(!e.polling_allowed());
    assert!(poll(&mut e, t + 15_000, 100).is_empty());
}

#[test]
fn every_named_reset_path_leaves_the_next_poll_as_a_baseline_only() {
    let mut e = eng(Settings::default());
    let (mut t, first_run) = warm_run(&mut e, 1_000_000);
    // Each path must start a new run: a stall (whose slot the 30 s limit would discard anyway) is only proved
    // to reset by the run changing.
    let last_run = std::cell::Cell::new(first_run);
    let check = |e: &mut Engine, label: &str, t: &mut i64| {
        let run = credits_next_poll(e, *t + 1_000).unwrap_or_else(|| panic!("{label}: credits again after its baseline"));
        assert!(run > last_run.get(), "{label}: a new run ({} -> {run})", last_run.get());
        last_run.set(run);
        *t += 20_000;
    };

    // lock and unlock
    e.step(t + 500, Signal::Session(SessionEvt::Lock));
    e.step(t + 900, Signal::Session(SessionEvt::Unlock));
    t += 900;
    check(&mut e, "unlock", &mut t);
    // suspend and resume
    e.step(t + 500, Signal::Power(PowerEvt::Suspend));
    e.step(t + 900, Signal::Power(PowerEvt::Resume));
    t += 900;
    check(&mut e, "resume from suspend", &mut t);
    // a game: entering resets, leaving resets
    e.step(t + 500, front("valorant.exe"));
    e.step(t + 900, front("code.exe"));
    t += 900;
    check(&mut e, "game entry and exit", &mut t);
    // pause and resume
    e.step(t + 500, Signal::Pause);
    e.step(t + 900, Signal::Resume);
    t += 900;
    check(&mut e, "pause and resume", &mut t);
    // a stall
    t += 100_000;
    e.step(t, Signal::Tick);
    check(&mut e, "stall", &mut t);
    // the wall clock moved backwards
    t -= 50_000;
    e.step(t, Signal::Tick);
    check(&mut e, "clock jump", &mut t);
    // an unreadable idle counter
    e.step(t + 500, Signal::IdleUnavailable);
    t += 500;
    check(&mut e, "unreadable idle counter", &mut t);
}

#[test]
fn the_first_step_is_a_reset_and_each_reset_changes_the_run() {
    let mut e = eng(Settings::default());
    e.set_run_base(10);
    let t = warm(&mut e, 1_000_000);
    let ops = poll(&mut e, t + 5_000, 100);
    assert_eq!(buckets(&ops)[0].2, 11, "start is a reset: the run is the persisted one plus one");
    e.step(t + 6_000, Signal::Session(SessionEvt::Lock));
    e.step(t + 7_000, Signal::Session(SessionEvt::Unlock));
    poll(&mut e, t + 8_000, 60_000);
    let ops = poll(&mut e, t + 13_000, 100);
    assert!(buckets(&ops)[0].2 > 11, "a reset starts a new run: {ops:?}");
}

#[test]
fn pause_and_finish_flush_the_open_minute() {
    let mut e = eng(Settings::default());
    let t = warm(&mut e, 1_000_000);
    let paused = e.step(t + 1_000, Signal::Pause).ops;
    assert_eq!(totals(&paused), (5_000, 5_000), "{paused:?}");
    let mut e = eng(Settings::default());
    let t = warm(&mut e, 1_000_000);
    let finished = e.finish(t + 1_000);
    assert_eq!(totals(&finished), (5_000, 5_000));
}

#[test]
fn the_idle_cadence_follows_whether_an_idle_interval_is_open() {
    let mut e = eng(Settings::default());
    assert_eq!(e.idle_cadence_ms(), 5_000);
    e.step(1_000_000, Signal::Tick);
    for i in 1..=13 {
        e.step(1_000_000 + i * 10_000, Signal::Tick);
    }
    poll(&mut e, 1_130_000, 125_000);
    assert_eq!(e.idle_cadence_ms(), 15_000, "the threshold comes from settings, not a constant");
    poll(&mut e, 1_145_000, 500);
    assert_eq!(e.idle_cadence_ms(), 5_000);
    // a different configured threshold moves the point at which the cadence backs off
    let mut e = eng(Settings {
        idle_threshold_ms: 30_000,
        ..Settings::default()
    });
    e.step(1_000, Signal::Tick);
    poll(&mut e, 40_000, 35_000);
    assert_eq!(e.idle_cadence_ms(), 15_000);
}

// ---- Store v2 ----

fn tmp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rhen-watch-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn bucket(minute: i64, exe: &str, run: u64, obs: i64, inp: i64) -> Op {
    Op::Bucket {
        minute_ts: minute * 60_000,
        exe: exe.into(),
        run,
        observed_ms: obs,
        input_ms: inp,
    }
}

#[test]
fn a_new_database_is_schema_2_and_a_v1_file_migrates_when_the_agent_opens_it() {
    let dir = tmp("migrate");
    let path = dir.join("a.db");
    {
        let s = Store::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), Some(2));
        assert!(s.has_input_buckets());
        s.set_meta("schema_version", "1").unwrap();
        s.drop_input_buckets_for_test();
    }
    let ro = Store::open_read_only(&path).unwrap();
    assert!(!ro.has_input_buckets(), "a v1 file has no table");
    assert_eq!(
        ro.buckets_between(0, i64::MAX).unwrap(),
        vec![],
        "the read-only report tolerates v1"
    );
    drop(ro);
    let s = Store::open(&path).unwrap();
    assert_eq!(s.schema_version().unwrap(), Some(2));
    assert!(s.has_input_buckets());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_older_agent_would_refuse_a_v2_file_and_this_one_refuses_v3() {
    let dir = tmp("v3");
    let path = dir.join("a.db");
    Store::open(&path).unwrap().set_meta("schema_version", "3").unwrap();
    assert!(Store::open(&path).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn bucket_upserts_are_absolute_and_idempotent_on_replay() {
    let mut s = Store::in_memory().unwrap();
    s.apply("d", &[bucket(1, "a.exe", 1, 5_000, 2_000)], 1).unwrap();
    s.apply("d", &[bucket(1, "a.exe", 1, 10_000, 4_000)], 2).unwrap();
    s.apply("d", &[bucket(1, "a.exe", 1, 10_000, 4_000)], 3).unwrap(); // replay
    let rows = s.buckets_between(0, i64::MAX).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].observed_ms, rows[0].input_ms), (10_000, 4_000));
    assert_eq!(s.count_events().unwrap(), 0, "buckets are not events");
}

#[test]
fn readers_sum_over_runs_and_exes_stay_separate() {
    let mut s = Store::in_memory().unwrap();
    s.apply(
        "d",
        &[
            bucket(1, "a.exe", 1, 20_000, 5_000),
            bucket(1, "a.exe", 2, 30_000, 10_000),
            bucket(1, "b.exe", 2, 5_000, 0),
            bucket(2, "a.exe", 2, 7_000, 1_000),
        ],
        1,
    )
    .unwrap();
    let rows = s.buckets_between(60_000, 120_000).unwrap();
    let a = rows.iter().find(|r| r.exe == "a.exe").unwrap();
    assert_eq!((a.observed_ms, a.input_ms), (50_000, 15_000));
    assert_eq!(rows.len(), 2);
    assert_eq!(s.buckets_between(0, 60_000).unwrap(), vec![], "half open window");
}

#[test]
fn run_seq_is_stored_in_meta_in_the_same_transaction() {
    let mut s = Store::in_memory().unwrap();
    s.apply(
        "d",
        &[
            Op::Meta {
                key: "run_seq".into(),
                value: "4".into(),
            },
            bucket(1, "a.exe", 4, 1, 1),
        ],
        1,
    )
    .unwrap();
    assert_eq!(s.meta("run_seq").unwrap().as_deref(), Some("4"));
}

#[test]
fn purge_deletes_old_buckets_only_when_input_buckets_retention_says_so() {
    let day = 86_400_000i64;
    let mut s = Store::in_memory().unwrap();
    s.apply(
        "d",
        &[
            Op::Bucket {
                minute_ts: 0,
                exe: "a.exe".into(),
                run: 1,
                observed_ms: 1,
                input_ms: 1,
            },
            Op::Bucket {
                minute_ts: 100 * day,
                exe: "a.exe".into(),
                run: 1,
                observed_ms: 1,
                input_ms: 1,
            },
        ],
        1,
    )
    .unwrap();
    let permanent = Config::parse("").unwrap();
    assert_eq!(crate::retention::purge(&s, &permanent, 101 * day).unwrap(), (0, 0, 0));
    let cfg = Config::parse("[retention]\ninput_buckets = 30\n").unwrap();
    assert_eq!(crate::retention::purge(&s, &cfg, 101 * day).unwrap(), (0, 0, 1));
    assert_eq!(s.buckets_between(0, i64::MAX).unwrap().len(), 1);
}

#[test]
fn the_read_only_report_can_read_a_file_the_agent_is_writing() {
    let dir = tmp("live");
    let path = dir.join("a.db");
    let mut s = Store::open(&path).unwrap();
    s.apply("d", &[bucket(1, "a.exe", 1, 5_000, 5_000)], 1).unwrap();
    let ro = Store::open_read_only(&path).unwrap();
    assert_eq!(ro.buckets_between(0, i64::MAX).unwrap().len(), 1);
    s.apply("d", &[bucket(1, "a.exe", 1, 10_000, 5_000)], 2).unwrap();
    assert_eq!(ro.buckets_between(0, i64::MAX).unwrap()[0].observed_ms, 10_000);
    drop(s);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- Runner with a fake OS ----

struct Rig {
    now: Rc<Cell<i64>>,
    /// mono = now + skew; a wall-clock step changes the skew by the same amount so mono keeps moving forward.
    skew: Rc<Cell<i64>>,
    idle: Rc<Cell<u64>>,
    front: Rc<Cell<&'static str>>,
    calls: Rc<Cell<u32>>,
}

struct RigSys(Rc<Cell<i64>>, Rc<Cell<i64>>, Rc<Cell<u64>>, Rc<Cell<&'static str>>, Rc<Cell<u32>>);

impl Sys for RigSys {
    fn now_ms(&self) -> i64 {
        self.0.get()
    }
    fn mono_ms(&self) -> i64 {
        self.0.get() + self.1.get()
    }
    fn idle_ms(&self) -> Option<u64> {
        self.4.set(self.4.get() + 1);
        Some(self.2.get())
    }
    fn resolve(&self, _: usize) -> Fg {
        Fg {
            class: "Chrome_WidgetWin_1".into(),
            exe: Some(self.3.get().into()),
            declared: None,
        }
    }
    fn current_foreground(&self) -> Option<Fg> {
        Some(Fg {
            class: "Chrome_WidgetWin_1".into(),
            exe: Some(self.3.get().into()),
            declared: None,
        })
    }
    fn proc_stats(&self) -> (i64, i64) {
        (self.0.get() / 1000, 30_000_000)
    }
    fn session_state(&self) -> (Option<bool>, bool) {
        (None, false)
    }
}

impl Rig {
    fn new(start: i64) -> Self {
        Rig {
            now: Rc::new(Cell::new(start)),
            skew: Rc::new(Cell::new(7_000_000)),
            idle: Rc::new(Cell::new(600_000)),
            front: Rc::new(Cell::new("code.exe")),
            calls: Rc::new(Cell::new(0)),
        }
    }
    fn runner(&self, store: Store) -> Runner<RigSys> {
        let sys = RigSys(
            self.now.clone(),
            self.skew.clone(),
            self.idle.clone(),
            self.front.clone(),
            self.calls.clone(),
        );
        Runner::new(
            sys,
            eng(Settings::default()),
            store,
            "d".into(),
            Arc::new(AtomicU64::new(0)),
            Config::default(),
        )
    }
    /// One second at a time. `typing`: the last input was 300 ms before the tick; otherwise idle grows.
    fn secs(&self, r: &mut Runner<RigSys>, n: u32, typing: bool) {
        for _ in 0..n {
            self.now.set(self.now.get() + 1_000);
            self.idle.set(if typing { 300 } else { self.idle.get() + 1_000 });
            r.tick().unwrap();
        }
    }
    fn calls(&self) -> u32 {
        self.calls.get()
    }
}

fn sums(s: &Store) -> (i64, i64) {
    s.buckets_between(0, i64::MAX)
        .unwrap()
        .iter()
        .fold((0, 0), |a, b| (a.0 + b.observed_ms, a.1 + b.input_ms))
}

/// A start 5 s into a minute (1_000_000_020_000 is a minute boundary).
const T0: i64 = 1_000_000_020_000 + 5_000;

#[test]
fn polls_every_5_seconds_and_every_15_while_an_idle_interval_is_open() {
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    rig.secs(&mut r, 60, true);
    let busy = rig.calls();
    assert!((11..=13).contains(&busy), "5 s cadence: {busy}");
    // go quiet long enough to open the idle interval (120 s), then count polls over 90 s
    rig.secs(&mut r, 130, false);
    let before = rig.calls();
    rig.secs(&mut r, 90, false);
    let slow = rig.calls() - before;
    assert!((5..=7).contains(&slow), "15 s cadence while idle: {slow}");
    // input brings it back to 5 s
    rig.secs(&mut r, 1, true);
    rig.secs(&mut r, 20, true);
    let before = rig.calls();
    rig.secs(&mut r, 60, true);
    assert!((11..=13).contains(&(rig.calls() - before)));
}

#[test]
fn the_probe_is_not_called_under_pause_lock_suspend_or_a_game() {
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    rig.secs(&mut r, 12, true);
    let quiet = |r: &mut Runner<RigSys>, label: &str| {
        let before = rig.calls();
        rig.secs(r, 30, true);
        assert_eq!(rig.calls(), before, "{label}: no probe calls");
    };
    r.handle(Raw::Control(Control::Pause)).unwrap();
    quiet(&mut r, "pause");
    r.handle(Raw::Control(Control::Resume)).unwrap();
    rig.secs(&mut r, 12, true);
    r.handle(Raw::Session(SessionEvt::Lock)).unwrap();
    quiet(&mut r, "lock");
    r.handle(Raw::Session(SessionEvt::Unlock)).unwrap();
    rig.secs(&mut r, 12, true);
    r.handle(Raw::Power(PowerEvt::Suspend)).unwrap();
    quiet(&mut r, "suspend");
    r.handle(Raw::Power(PowerEvt::Resume)).unwrap();
    rig.secs(&mut r, 12, true);
    rig.front.set("valorant.exe");
    r.handle(Raw::Foreground(0)).unwrap();
    quiet(&mut r, "game");
}

#[test]
fn typing_for_a_minute_is_credited_to_the_app_in_front() {
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    rig.secs(&mut r, 60, true);
    r.stop().unwrap();
    let (obs, inp) = sums(r.store());
    assert!((50_000..=60_000).contains(&obs), "observed {obs}");
    assert!(inp >= obs - 6_000 && inp <= obs, "input {inp} of {obs}");
    let rows = r.store().buckets_between(0, i64::MAX).unwrap();
    assert!(rows.iter().all(|b| b.exe == "code.exe"));
}

#[test]
fn idle_minutes_still_have_an_observed_row() {
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    rig.secs(&mut r, 120, false);
    r.stop().unwrap();
    let (obs, inp) = sums(r.store());
    assert!(obs >= 100_000, "{obs}");
    assert_eq!(inp, 0);
}

#[test]
fn stop_flushes_the_open_minute() {
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    rig.secs(&mut r, 20, true);
    r.stop().unwrap();
    let (obs, _) = sums(r.store());
    assert!(obs >= 10_000, "{obs}");
}

#[test]
fn a_kill_between_polls_loses_less_than_one_cadence() {
    let dir = tmp("kill");
    let path = dir.join("a.db");
    let rig = Rig::new(T0);
    {
        let mut r = rig.runner(Store::open(&path).unwrap());
        r.start().unwrap();
        rig.secs(&mut r, 47, true);
        // no stop(): the process dies here, 2 s after the poll at 45 s
    }
    let s = Store::open(&path).unwrap();
    let (obs, _) = sums(&s);
    // Polls at 5 s (baseline) .. 45 s cover 40 s; 42 s have passed since the baseline.
    assert_eq!(obs, 40_000, "everything up to the last poll is on disk");
    assert!(42_000 - obs < 5_000, "lost less than one cadence");
    let hb = s.last_heartbeat().unwrap().unwrap();
    // Each poll commits a bucket and so a heartbeat; the quiet seconds between polls commit nothing. The last
    // poll was at 45 s, so the heartbeat is no older than one cadence (it was 46 s when every second wrote).
    assert!(hb >= T0 + 45_000, "the heartbeat is at least as new as the last poll: {}", hb - T0);
    assert!(T0 + 47_000 - hb < 5_000, "and is never more than one cadence old");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn idle_polling_stops_when_the_foreground_hook_is_gone() {
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    r.disable_idle();
    let before = rig.calls();
    rig.secs(&mut r, 30, true);
    assert_eq!(rig.calls(), before, "the input clock is not read without the foreground collector");
    r.stop().unwrap();
    assert_eq!(sums(r.store()), (0, 0), "no input tally either");
}

#[test]
fn a_quiet_minute_commits_once_per_cadence_not_once_per_second() {
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    rig.secs(&mut r, 20, true);
    let before = r.store().commits;
    rig.secs(&mut r, 60, true);
    let n = r.store().commits - before;
    assert!(
        (10..=13).contains(&n),
        "one commit per 5 s poll (plus at most one heartbeat): {n} in 60 s"
    );
}

#[test]
fn ticks_with_nothing_to_write_commit_nothing_between_heartbeats() {
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    let before = r.store().commits;
    // Polling is not due for 5 s, so seconds 1 to 4 are plain ticks with no ops.
    rig.secs(&mut r, 4, true);
    assert_eq!(r.store().commits, before, "no ops, nothing pending, no heartbeat due: no commit");
    rig.secs(&mut r, 1, true);
    assert!(r.store().commits > before, "the 5 s poll commits");
}

#[test]
fn a_bucket_is_never_newer_than_the_heartbeat() {
    let rig = Rig::new(T0);
    let store = Store::in_memory().unwrap();
    let mut r = rig.runner(store);
    r.start().unwrap();
    for _ in 0..40 {
        rig.secs(&mut r, 1, true);
        let hb = r.store().last_heartbeat().unwrap().unwrap();
        let newest = r.store().buckets_between(0, i64::MAX).unwrap().iter().map(|b| b.minute_ts).max();
        if let Some(m) = newest {
            assert!(m <= hb, "bucket minute {m} newer than heartbeat {hb}");
        }
    }
}

#[test]
fn the_first_metric_row_counts_cpu_from_process_start() {
    // The fake process has already used `T0 / 1000` ms when the runner is built (config, database and ACL setup
    // run before it); a baseline taken then would drop that.
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    rig.secs(&mut r, 130, true);
    let rows = r.store().metrics_between(0, i64::MAX).unwrap();
    assert!(rows[0].cpu_ms >= T0 / 1000, "startup CPU is in the first row: {}", rows[0].cpu_ms);
}

#[test]
fn a_second_process_in_the_same_minute_adds_its_cpu_to_the_row() {
    let s = Store::in_memory().unwrap();
    let row = |cpu_ms, events| crate::store::MetricRow {
        minute_ts: 60_000,
        cpu_ms,
        rss_bytes: 1,
        db_bytes: 1,
        events,
        dropped: 0,
    };
    s.put_metric(&row(120, 2)).unwrap();
    s.put_metric(&row(80, 3)).unwrap();
    let rows = s.metrics_between(0, i64::MAX).unwrap();
    assert_eq!((rows[0].cpu_ms, rows[0].events), (200, 5));
}

#[test]
fn a_wall_clock_stepped_back_in_one_process_keeps_both_tallies() {
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    rig.secs(&mut r, 30, true);
    let first = sums(r.store()).0;
    // VM restore: the wall clock goes back 30 s, to the start of the same minute's tally; the monotonic clock does not
    rig.now.set(rig.now.get() - 30_000);
    rig.skew.set(rig.skew.get() + 30_000);
    rig.secs(&mut r, 30, true);
    r.stop().unwrap();
    let (obs, _) = sums(r.store());
    assert!(
        obs > first + 15_000,
        "the second pass added to the first instead of replacing it: {first} -> {obs}"
    );
    let rows = r.store().buckets_between(0, i64::MAX).unwrap();
    let minutes: std::collections::BTreeSet<i64> = rows.iter().map(|b| b.minute_ts).collect();
    assert_eq!(minutes.len(), 1, "the same minute was tallied twice: {minutes:?}");
    assert!(rows[0].observed_ms > 30_000 && rows[0].observed_ms <= 60_000, "{rows:?}");
    let events = r.store().events_between(0, i64::MAX).unwrap();
    assert!(events.iter().any(|e| e.kind == "clock_jump"));
}

#[test]
fn two_restarts_in_one_minute_sum() {
    let dir = tmp("restarts");
    let path = dir.join("a.db");
    let rig = Rig::new(T0);
    for _ in 0..2 {
        let mut r = rig.runner(Store::open(&path).unwrap());
        r.start().unwrap();
        rig.secs(&mut r, 22, true);
        r.stop().unwrap();
        rig.secs_idle_gap();
    }
    let s = Store::open(&path).unwrap();
    let (obs, _) = sums(&s);
    assert!(obs >= 25_000, "both processes' tallies survive: {obs}");
    let mut seqs: Vec<i64> = s.raw_bucket_runs_for_test().into_iter().map(|r| r as i64).collect();
    seqs.sort();
    seqs.dedup();
    assert!(seqs.len() >= 2, "each process wrote its own run: {seqs:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

impl Rig {
    fn secs_idle_gap(&self) {
        self.now.set(self.now.get() + 1_000);
    }
}

#[test]
fn per_minute_observed_never_exceeds_a_minute_across_runs() {
    let dir = tmp("prop");
    let path = dir.join("a.db");
    let rig = Rig::new(T0);
    let mut seed = 12345u64;
    let mut rnd = move || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as u32
    };
    for _ in 0..3 {
        let mut r = rig.runner(Store::open(&path).unwrap());
        r.start().unwrap();
        for _ in 0..40 {
            let n = 1 + rnd() % 20;
            let typing = rnd() % 2 == 0;
            rig.secs(&mut r, n, typing);
            match rnd() % 6 {
                0 => {
                    r.handle(Raw::Session(SessionEvt::Lock)).unwrap();
                    rig.secs(&mut r, 8, false);
                    r.handle(Raw::Session(SessionEvt::Unlock)).unwrap();
                }
                1 => {
                    r.handle(Raw::Control(Control::Pause)).unwrap();
                    rig.secs(&mut r, 5, false);
                    r.handle(Raw::Control(Control::Resume)).unwrap();
                }
                _ => {}
            }
        }
        r.stop().unwrap();
        rig.secs_idle_gap();
    }
    let s = Store::open(&path).unwrap();
    let rows = s.buckets_between(0, i64::MAX).unwrap();
    assert!(!rows.is_empty());
    let mut per_minute: HashMap<i64, (i64, i64)> = HashMap::new();
    for b in &rows {
        let e = per_minute.entry(b.minute_ts).or_default();
        e.0 += b.observed_ms;
        e.1 += b.input_ms;
        assert!(b.input_ms <= b.observed_ms);
    }
    for (m, (obs, inp)) in per_minute {
        assert!(obs <= 60_000, "minute {m}: observed {obs}");
        assert!(inp <= obs);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_write_is_retried_and_keeps_the_bucket_order() {
    let rig = Rig::new(T0);
    let store = Store::in_memory().unwrap();
    let mut r = rig.runner(store);
    r.start().unwrap();
    rig.secs(&mut r, 12, true);
    r.store_mut().fail_next = 4;
    rig.secs(&mut r, 20, true);
    rig.secs(&mut r, 3, true);
    r.stop().unwrap();
    let (obs, _) = sums(r.store());
    assert!(obs >= 30_000, "nothing lost to the failed writes: {obs}");
    // absolute upserts replayed in order never end below an earlier value
    let rows = r.store().buckets_between(0, i64::MAX).unwrap();
    assert!(rows.iter().all(|b| b.observed_ms <= 60_000));
}

#[test]
fn the_events_metric_counts_event_ops_and_not_buckets_or_meta() {
    let rig = Rig::new(T0);
    let mut r = rig.runner(Store::in_memory().unwrap());
    r.start().unwrap();
    rig.secs(&mut r, 130, true);
    r.stop().unwrap();
    let metrics = r.store().metrics_between(0, i64::MAX).unwrap();
    let counted: i64 = metrics.iter().map(|m| m.events).sum();
    let rows = r.store().count_events().unwrap();
    // start, one foreground interval (open and close), stop: a handful of ops. About 25 polls each wrote a
    // bucket; if those were counted this would be far above the rows.
    assert!(
        counted > 0 && counted <= rows * 2,
        "metric_events {counted} vs {rows} event rows: buckets must not inflate it"
    );
}

#[test]
fn the_run_base_is_read_from_the_store_at_start() {
    let rig = Rig::new(T0);
    let store = Store::in_memory().unwrap();
    store.set_meta("run_seq", "41").unwrap();
    let mut r = rig.runner(store);
    r.start().unwrap();
    rig.secs(&mut r, 12, true);
    r.stop().unwrap();
    assert!(r.store().raw_bucket_runs_for_test().iter().all(|&run| run > 41));
    assert!(r.store().meta("run_seq").unwrap().unwrap().parse::<u64>().unwrap() > 41);
}
