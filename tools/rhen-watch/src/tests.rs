//! Tests of the pure rules, run on any OS. The Windows layer is compiled on windows-latest in CI and
//! exercised by the manual run in README.md.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;

use crate::categories::{Catalogue, is_shell_window};
use crate::config::Config;
use crate::derive::Params;
use crate::engine::{Engine, Fg, PowerEvt, SessionEvt, Settings, Signal};
use crate::model::{Op, SRC_AGENT, attrs};
use crate::report::{ReportInput, build};
use crate::runner::{Raw, Runner, Sys};
use crate::store::Store;
use crate::tz::TzOffset;

fn engine() -> Engine {
    let mut n = 0u32;
    Engine::new(
        Settings::default(),
        Catalogue::new(&HashMap::new(), &[]),
        Box::new(move || {
            n += 1;
            format!("id{n}")
        }),
    )
}

fn fg(exe: &str) -> Signal {
    Signal::Foreground(Fg {
        class: "Chrome_WidgetWin_1".into(),
        exe: Some(exe.into()),
    })
}

/// An idle sample taken at `t`, with the monotonic clock reading the same.
fn idle_at(t: i64, idle_ms: u64) -> Signal {
    Signal::Idle { idle_ms, mono_ms: t }
}

fn opens(ops: &[Op]) -> Vec<String> {
    ops.iter()
        .filter_map(|o| {
            if let Op::Open { kind, attrs, .. } = o {
                Some(format!("{kind}:{}", attrs.get("exe").and_then(|v| v.as_str()).unwrap_or("")))
            } else {
                None
            }
        })
        .collect()
}

fn closes(ops: &[Op]) -> usize {
    ops.iter().filter(|o| matches!(o, Op::Close { .. })).count()
}

#[test]
fn repeat_of_same_app_does_not_split_the_interval() {
    let mut e = engine();
    assert_eq!(opens(&e.step(1000, fg("code.exe")).ops), ["app:code.exe"]);
    assert!(e.step(2000, fg("code.exe")).ops.is_empty());
    let s = e.step(3000, fg("chrome.exe"));
    assert_eq!(closes(&s.ops), 1);
    assert_eq!(opens(&s.ops), ["app:chrome.exe"]);
}

#[test]
fn shell_windows_do_not_end_the_app_interval() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    let s = e.step(
        2000,
        Signal::Foreground(Fg {
            class: "Shell_TrayWnd".into(),
            exe: Some("explorer.exe".into()),
        }),
    );
    assert!(s.ops.is_empty());
    assert!(is_shell_window("shell_traywnd", None) && !is_shell_window("Chrome_WidgetWin_1", None));
}

#[test]
fn category_comes_from_exe_not_window_class() {
    let mut e = engine();
    let ops = e.step(1000, fg("discord.exe")).ops;
    let Op::Open { attrs, .. } = &ops[0] else { panic!() };
    assert_eq!(attrs["category"], "chat");
    let ops = e.step(2000, fg("mystery.exe")).ops;
    let Op::Open { attrs, .. } = &ops[1] else { panic!() };
    assert_eq!(attrs["category"], "other");
}

#[test]
fn a_game_in_front_is_suppressed_and_never_named() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    let s = e.step(2000, fg("VALORANT-Win64-Shipping.exe".to_lowercase().as_str()));
    let Op::Open { kind, attrs, .. } = &s.ops[1] else { panic!() };
    assert_eq!(kind, "suppressed");
    assert!(!attrs.values().any(|v| v.to_string().contains("valorant")));
    assert!(e.suppressed());
    // idle sampling does nothing while suppressed
    assert!(e.step(10_000, idle_at(10_000, 500_000)).ops.is_empty());
    e.step(20_000, fg("code.exe"));
    assert!(!e.suppressed());
}

#[test]
fn unreadable_exe_is_unknown_not_idle() {
    let mut e = engine();
    let ops = e
        .step(
            1000,
            Signal::Foreground(Fg {
                class: "X".into(),
                exe: None,
            }),
        )
        .ops;
    let Op::Open { kind, .. } = &ops[0] else { panic!() };
    assert_eq!(kind, "unknown");
}

#[test]
fn idle_starts_at_last_input_and_ends_at_next_input() {
    let mut e = engine();
    let t0 = 1_000_000;
    e.step(t0, Signal::Tick);
    for i in 1..=13 {
        e.step(t0 + i * 10_000, Signal::Tick);
    }
    // 130 s on, the sample says input was last seen 125 s ago: idle began at t0 + 5 s
    let s = e.step(t0 + 130_000, idle_at(t0 + 130_000, 125_000));
    let Op::Open { ts, kind, .. } = &s.ops[0] else { panic!() };
    assert_eq!((kind.as_str(), *ts), ("idle", t0 + 5_000));
    for i in 14..=19 {
        e.step(t0 + i * 10_000, Signal::Tick);
    }
    let s = e.step(t0 + 200_000, idle_at(t0 + 200_000, 1_000));
    assert_eq!(
        s.ops,
        vec![Op::Close {
            id: "id1".into(),
            ts: t0 + 199_000
        }]
    );
}

#[test]
fn lock_closes_foreground_and_unlock_asks_for_a_fresh_look() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    let s = e.step(5000, Signal::Session(SessionEvt::Lock));
    assert_eq!(closes(&s.ops), 1);
    // the lock screen's own window is ignored while held
    assert!(
        e.step(
            5100,
            Signal::Foreground(Fg {
                class: "LockApp".into(),
                exe: Some("lockapp.exe".into())
            })
        )
        .ops
        .is_empty()
    );
    let s = e.step(9000, Signal::Session(SessionEvt::Unlock));
    assert!(s.refresh_foreground);
    assert_eq!(opens(&e.step(9001, fg("chrome.exe")).ops), ["app:chrome.exe"]);
}

#[test]
fn a_stall_closes_at_the_last_tick_and_records_unknown() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    e.step(5000, Signal::Tick);
    let s = e.step(3_600_000, Signal::Tick); // slept an hour with no suspend message
    assert!(s.refresh_foreground);
    assert!(s.ops.contains(&Op::Close {
        id: "id1".into(),
        ts: 5000
    }));
    assert!(
        s.ops
            .iter()
            .any(|o| matches!(o, Op::Instant { kind, ts: 5000, end: Some(3_600_000), .. } if kind == "unknown"))
    );
}

#[test]
fn a_backwards_clock_is_recorded_and_nothing_runs_on() {
    let mut e = engine();
    e.step(100_000, fg("code.exe"));
    let s = e.step(50_000, Signal::Tick);
    assert!(s.ops.iter().any(|o| matches!(o, Op::Instant { kind, .. } if kind == "clock_jump")));
    assert!(closes(&s.ops) >= 1);
}

#[test]
fn suspend_and_display_states() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    let s = e.step(2000, Signal::Power(PowerEvt::DisplayOff));
    assert_eq!(closes(&s.ops), 0, "display off alone does not end the app");
    let s = e.step(3000, Signal::Power(PowerEvt::Suspend));
    assert_eq!(closes(&s.ops), 1);
    assert!(e.step(9000, Signal::Power(PowerEvt::Resume)).refresh_foreground);
}

#[test]
fn off_collectors_write_nothing() {
    let settings = Settings {
        foreground: false,
        session: false,
        power: false,
        idle: false,
        ..Settings::default()
    };
    let mut e = Engine::new(settings, Catalogue::new(&HashMap::new(), &[]), Box::new(|| "x".into()));
    assert!(e.step(1, fg("code.exe")).ops.is_empty());
    assert!(e.step(2, Signal::Session(SessionEvt::Lock)).ops.is_empty());
    assert!(e.step(3, Signal::Power(PowerEvt::Suspend)).ops.is_empty());
    assert!(e.step(4, idle_at(4, 10_000_000)).ops.is_empty());
}

#[test]
fn extra_games_come_from_config_and_categories_from_the_categories_file() {
    let cfg = Config::parse("extra_games = [\"MyGame.exe\"]\n").unwrap();
    let file = crate::categories::CategoryFile::parse("[exe]\n\"Foo.exe\" = \"editor\"\n").unwrap();
    let c = Catalogue::with_file(&file, &cfg.extra_games);
    assert!(c.is_game("mygame.exe"));
    assert_eq!(c.category("foo.exe"), "editor");
}

// ---- store ----

fn open_iv(id: &str, ts: i64) -> Op {
    Op::Open {
        id: id.into(),
        source: "foreground",
        kind: "app".into(),
        ts,
        attrs: attrs([("exe", json!("code.exe")), ("category", json!("editor"))]),
    }
}

#[test]
fn rows_are_written_once_when_an_interval_closes() {
    let mut s = Store::in_memory().unwrap();
    s.apply("d", &[open_iv("a", 1000)], 1000).unwrap();
    assert_eq!(s.count_events().unwrap(), 0, "an open interval is not a row yet");
    assert_eq!(s.open_rows().len(), 1);
    s.apply("d", &[Op::Close { id: "a".into(), ts: 4000 }], 4000).unwrap();
    let rows = s.events_between(0, 10_000).unwrap();
    assert_eq!((rows.len(), rows[0].ts_end), (1, Some(4000)));
    assert!(s.open_rows().is_empty());
}

#[test]
fn close_never_ends_before_start() {
    let mut s = Store::in_memory().unwrap();
    s.apply("d", &[open_iv("a", 5000), Op::Close { id: "a".into(), ts: 100 }], 5000)
        .unwrap();
    assert_eq!(s.events_between(0, 10_000).unwrap()[0].ts_end, Some(5000));
}

#[test]
fn recovery_closes_open_intervals_at_the_last_heartbeat_and_records_the_gap() {
    let dir = std::env::temp_dir().join(format!("rhen-watch-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("a.db");
    let _ = std::fs::remove_file(&path);
    {
        let mut s = Store::open(&path).unwrap();
        s.apply("d", &[open_iv("a", 1000)], 1000).unwrap();
        s.apply("d", &[], 61_000).unwrap(); // heartbeat; then the process dies
    }
    let mut s = Store::open(&path).unwrap();
    assert_eq!(s.open_rows().len(), 1, "open state survives the crash");
    let gap = s.recover("d", 3_600_000).unwrap();
    assert_eq!(gap, Some((61_000, 3_600_000)));
    let rows = s.events_between(0, 4_000_000).unwrap();
    assert_eq!(rows.iter().find(|r| r.id == "a").unwrap().ts_end, Some(61_000));
    let unknown = rows.iter().find(|r| r.kind == "unknown").unwrap();
    assert_eq!(
        (unknown.ts_start, unknown.ts_end, unknown.source.as_str()),
        (61_000, Some(3_600_000), SRC_AGENT)
    );
    assert!(s.open_rows().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn instants_in_the_same_millisecond_get_distinct_ids() {
    let mut s = Store::in_memory().unwrap();
    let ev = || Op::Instant {
        source: "session",
        kind: "logon".into(),
        ts: 5,
        end: None,
        attrs: Default::default(),
    };
    s.apply("d", &[ev(), ev(), ev()], 5).unwrap();
    assert_eq!(s.count_events().unwrap(), 3);
}

#[test]
fn newer_schema_is_refused() {
    let s = Store::in_memory().unwrap();
    s.set_meta("schema_version", "99").unwrap();
    // reopening the same connection is not possible in memory; check via a file
    let dir = std::env::temp_dir().join(format!("rhen-watch-schema-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("b.db");
    let _ = std::fs::remove_file(&path);
    Store::open(&path).unwrap().set_meta("schema_version", "99").unwrap();
    assert!(Store::open(&path).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- config and retention ----

#[test]
fn defaults_are_permanent_and_title_ocr_off() {
    let c = Config::parse("").unwrap();
    assert_eq!(c.retention.events.days().unwrap(), None);
    assert!(c.collectors.foreground && !c.collectors.title && !c.collectors.ocr);
}

#[test]
fn config_rejects_what_would_mislead() {
    assert!(Config::parse("[collectors]\nocr = true\n").is_err());
    assert!(Config::parse("[retention]\nevents = 0\n").is_err());
    assert!(Config::parse("[retention]\nevents = \"forever\"\n").is_err());
    assert!(Config::parse("typo_key = 1\n").is_err());
    assert_eq!(
        Config::parse("[retention]\nevents = 30\n")
            .unwrap()
            .retention
            .events
            .days()
            .unwrap(),
        Some(30)
    );
}

#[test]
fn shipped_template_parses_and_equals_defaults() {
    let c = Config::parse(crate::config::TEMPLATE).unwrap();
    assert_eq!(c.idle_threshold_secs, Some(120));
    assert_eq!(c.retention.events.days().unwrap(), None);
}

#[test]
fn purge_deletes_old_rows_only_when_asked() {
    let mut s = Store::in_memory().unwrap();
    let day = 86_400_000;
    s.apply(
        "d",
        &[
            open_iv("old", 0),
            Op::Close {
                id: "old".into(),
                ts: 1000,
            },
            open_iv("new", 100 * day),
            Op::Close {
                id: "new".into(),
                ts: 100 * day + 1000,
            },
        ],
        100 * day,
    )
    .unwrap();
    let permanent = Config::parse("").unwrap();
    assert_eq!(crate::retention::purge(&s, &permanent, 101 * day).unwrap(), (0, 0, 0));
    let thirty = Config::parse("[retention]\nevents = 30\n").unwrap();
    assert_eq!(crate::retention::purge(&s, &thirty, 101 * day).unwrap().0, 1);
    assert_eq!(s.count_events().unwrap(), 1);
}

// ---- runner with a fake OS ----

struct Fake {
    now: Rc<Cell<i64>>,
    idle: Rc<Cell<u64>>,
    front: Rc<Cell<&'static str>>,
}

impl Sys for Fake {
    fn now_ms(&self) -> i64 {
        self.now.get()
    }
    fn mono_ms(&self) -> i64 {
        self.now.get()
    }
    fn idle_ms(&self) -> Option<u64> {
        Some(self.idle.get())
    }
    fn resolve(&self, hwnd: usize) -> Fg {
        Fg {
            class: "Chrome_WidgetWin_1".into(),
            exe: Some(["code.exe", "chrome.exe"][hwnd % 2].into()),
        }
    }
    fn current_foreground(&self) -> Option<Fg> {
        Some(Fg {
            class: "Chrome_WidgetWin_1".into(),
            exe: Some(self.front.get().into()),
        })
    }
    fn proc_stats(&self) -> (i64, i64) {
        (self.now.get() / 1000, 30_000_000)
    }
}

#[test]
fn a_day_through_the_runner_reports_honestly() {
    let now = Rc::new(Cell::new(1_000_000_000_000i64));
    let idle = Rc::new(Cell::new(0u64));
    let front = Rc::new(Cell::new("code.exe"));
    let dropped = Arc::new(AtomicU64::new(0));
    let t0 = now.get();
    let mut r = Runner::new(
        Fake {
            now: now.clone(),
            idle: idle.clone(),
            front: front.clone(),
        },
        engine(),
        Store::in_memory().unwrap(),
        "d".into(),
        dropped.clone(),
        Config::default(),
    );
    r.start().unwrap();
    // 30 minutes in code, then a switch to chrome (hwnd 1)
    for _ in 0..1800 {
        now.set(now.get() + 1000);
        r.tick().unwrap();
    }
    r.handle(Raw::Foreground(1)).unwrap();
    // 10 minutes in chrome of which the last 5 are idle
    for i in 0..600 {
        now.set(now.get() + 1000);
        idle.set(if i >= 300 { (i - 299) as u64 * 1000 } else { 0 });
        r.tick().unwrap();
    }
    dropped.store(2, Ordering::Relaxed);
    r.tick().unwrap();
    r.stop().unwrap();
    let from = t0 - t0 % 86_400_000;
    let catalogue = Catalogue::new(&HashMap::new(), &[]);
    let params = Params::from(&Config::default().derive);
    let text = build(
        r.store(),
        &ReportInput {
            label: "test",
            from,
            to: from + 86_400_000,
            open_until: now.get(),
            tz: TzOffset::fixed(0),
            catalogue: &catalogue,
            params: &params,
            idle_collector: true,
        },
    )
    .unwrap();
    assert!(text.contains("code.exe"), "{text}");
    assert!(text.contains("chrome.exe"), "{text}");
    assert!(text.contains("editor"), "{text}");
    assert!(text.contains("Agent cost"), "{text}");
    let rows = r.store().events_between(from, from + 86_400_000).unwrap();
    assert!(rows.iter().any(|e| e.kind == "dropped"), "dropped signals are recorded");
    assert!(rows.iter().any(|e| e.kind == "idle"));
    assert!(rows.iter().all(|e| e.ts_end.is_some()));
}

#[test]
fn civil_date_round_trip() {
    for (y, m, d) in [(1970, 1, 1), (2026, 11, 6), (2024, 2, 29), (2000, 3, 1)] {
        assert_eq!(crate::cli::civil_from_days(crate::cli::days_from_civil(y, m, d)), (y, m, d));
    }
    assert_eq!(crate::cli::days_from_civil(1970, 1, 1), 0);
}

#[test]
fn report_on_an_empty_database_says_so() {
    let s = Store::in_memory().unwrap();
    let catalogue = Catalogue::new(&HashMap::new(), &[]);
    let params = Params::from(&Config::default().derive);
    let text = build(
        &s,
        &ReportInput {
            label: "2026-01-01",
            from: 0,
            to: 86_400_000,
            open_until: 0,
            tz: TzOffset::fixed(60),
            catalogue: &catalogue,
            params: &params,
            idle_collector: true,
        },
    )
    .unwrap();
    assert!(text.contains("Nothing was captured"));
    assert!(text.contains("UTC+01:00"));
}

// ---- review findings ----

#[test]
fn a_known_sleep_is_a_suspended_interval_not_unknown() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    e.step(2000, Signal::Power(PowerEvt::Suspend));
    let s = e.step(3_600_000, Signal::Power(PowerEvt::Resume));
    assert!(
        !s.ops.iter().any(|o| matches!(o, Op::Instant { kind, .. } if kind == "unknown")),
        "{:?}",
        s.ops
    );
    assert!(
        s.ops.contains(&Op::Close {
            id: "id2".into(),
            ts: 3_600_000
        }),
        "the suspended interval runs to the resume: {:?}",
        s.ops
    );
    assert!(s.refresh_foreground);
}

#[test]
fn a_lock_held_across_a_stall_is_not_unknown() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    e.step(2000, Signal::Session(SessionEvt::Lock));
    let s = e.step(3_600_000, Signal::Session(SessionEvt::Unlock));
    assert!(
        !s.ops.iter().any(|o| matches!(o, Op::Instant { kind, .. } if kind == "unknown")),
        "{:?}",
        s.ops
    );
    assert!(s.ops.contains(&Op::Close {
        id: "id2".into(),
        ts: 3_600_000
    }));
}

#[test]
fn a_stall_with_no_announcement_is_still_unknown() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    e.step(2000, Signal::Power(PowerEvt::DisplayOff));
    let s = e.step(3_600_000, Signal::Tick);
    assert!(s.ops.iter().any(|o| matches!(o, Op::Instant { kind, .. } if kind == "unknown")));
    assert!(closes(&s.ops) >= 2, "foreground and the display-off interval end at the last tick");
}

#[test]
fn idle_does_not_run_through_a_game() {
    let mut e = engine();
    let t0 = 1_000_000;
    e.step(t0, fg("code.exe"));
    for i in 1..=20 {
        e.step(t0 + i * 10_000, Signal::Tick);
    }
    let s = e.step(t0 + 200_000, idle_at(t0 + 200_000, 150_000));
    let idle_id = match &s.ops[0] {
        Op::Open { id, kind, .. } if kind == "idle" => id.clone(),
        other => panic!("{other:?}"),
    };
    let s = e.step(t0 + 201_000, fg("valorant.exe"));
    assert!(
        s.ops.contains(&Op::Close {
            id: idle_id,
            ts: t0 + 201_000
        }),
        "{:?}",
        s.ops
    );
    assert!(
        e.step(t0 + 206_000, idle_at(t0 + 206_000, 155_000)).ops.is_empty(),
        "and it does not reopen while suppressed"
    );
}

#[test]
fn core_window_is_an_app_unless_a_shell_host_owns_it() {
    let core = |exe: &str| {
        Signal::Foreground(Fg {
            class: "Windows.UI.Core.CoreWindow".into(),
            exe: Some(exe.into()),
        })
    };
    let mut e = engine();
    assert_eq!(opens(&e.step(1000, core("calculatorapp.exe")).ops), ["app:calculatorapp.exe"]);
    assert!(e.step(2000, core("startmenuexperiencehost.exe")).ops.is_empty());
}

#[test]
fn instants_do_not_scan_and_stay_unique_across_stores() {
    let ev = || Op::Instant {
        source: "session",
        kind: "logon".into(),
        ts: 5,
        end: None,
        attrs: Default::default(),
    };
    let mut a = Store::in_memory().unwrap();
    let mut b = Store::in_memory().unwrap();
    a.apply("d", &[ev()], 5).unwrap();
    b.apply("d", &[ev()], 5).unwrap();
    assert_ne!(a.events_between(0, 10).unwrap()[0].id, b.events_between(0, 10).unwrap()[0].id);
}

#[test]
fn read_only_open_reads_and_cannot_write() {
    let dir = std::env::temp_dir().join(format!("rhen-watch-ro-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("c.db");
    let _ = std::fs::remove_file(&path);
    {
        let mut s = Store::open(&path).unwrap();
        s.apply("d", &[open_iv("a", 1000)], 1000).unwrap();
    }
    let ro = Store::open_read_only(&path).unwrap();
    assert_eq!(ro.open_rows().len(), 1);
    assert!(ro.set_meta("x", "y").is_err());
    assert!(Store::open_read_only(&dir.join("missing.db")).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

fn fake(now: &Rc<Cell<i64>>, cfg: Config, store: Store) -> Runner<Fake> {
    let sys = Fake {
        now: now.clone(),
        idle: Rc::new(Cell::new(0)),
        front: Rc::new(Cell::new("code.exe")),
    };
    Runner::new(sys, engine(), store, "d".into(), Arc::new(AtomicU64::new(0)), cfg)
}

#[test]
fn a_write_failure_is_retried_without_losing_rows_and_then_gives_up() {
    let now = Rc::new(Cell::new(1_000_000_000_000i64));
    let mut store = Store::in_memory().unwrap();
    store.fail_next = 3;
    let mut r = fake(&now, Config::default(), store);
    r.start().unwrap(); // fails quietly
    for _ in 0..5 {
        now.set(now.get() + 1000);
        r.tick().unwrap();
    }
    r.stop().unwrap();
    let rows = r.store().events_between(0, i64::MAX).unwrap();
    assert!(
        rows.iter().any(|e| e.kind == "start") && rows.iter().any(|e| e.kind == "stop"),
        "nothing lost: {rows:?}"
    );

    let mut dead = Store::in_memory().unwrap();
    dead.fail_next = 10_000;
    let mut r = fake(&now, Config::default(), dead);
    let mut result = Ok(());
    for _ in 0..200 {
        now.set(now.get() + 1000);
        result = r.tick();
        if result.is_err() {
            break;
        }
    }
    assert!(result.unwrap_err().contains("cannot write to the database"));
}

#[test]
fn retention_purge_runs_when_the_day_changes() {
    let day = 86_400_000i64;
    let now = Rc::new(Cell::new(200 * day + 1000));
    let mut store = Store::in_memory().unwrap();
    store
        .apply(
            "d",
            &[
                open_iv("old", 0),
                Op::Close {
                    id: "old".into(),
                    ts: 1000,
                },
            ],
            0,
        )
        .unwrap();
    let cfg = Config::parse("[retention]\nevents = 30\n").unwrap();
    let mut r = fake(&now, cfg, store);
    r.tick().unwrap();
    assert_eq!(
        r.store().events_between(0, 100).unwrap().len(),
        0,
        "purged on the first tick of the day"
    );
    // an old row inserted later in the same day is left until tomorrow
    r.store_mut()
        .apply(
            "d",
            &[
                open_iv("old2", 0),
                Op::Close {
                    id: "old2".into(),
                    ts: 1000,
                },
            ],
            0,
        )
        .unwrap();
    now.set(now.get() + 5000);
    r.tick().unwrap();
    assert_eq!(r.store().events_between(0, 100).unwrap().len(), 1);
    now.set(now.get() + day);
    r.tick().unwrap();
    assert_eq!(r.store().events_between(0, 100).unwrap().len(), 0);
}

struct NoIdle(Fake);
impl Sys for NoIdle {
    fn now_ms(&self) -> i64 {
        self.0.now_ms()
    }
    fn mono_ms(&self) -> i64 {
        self.0.mono_ms()
    }
    fn idle_ms(&self) -> Option<u64> {
        None
    }
    fn resolve(&self, h: usize) -> Fg {
        self.0.resolve(h)
    }
    fn current_foreground(&self) -> Option<Fg> {
        self.0.current_foreground()
    }
    fn proc_stats(&self) -> (i64, i64) {
        self.0.proc_stats()
    }
}

#[test]
fn an_unreadable_idle_counter_is_recorded_once_as_degraded() {
    let now = Rc::new(Cell::new(1_000_000_000_000i64));
    let inner = Fake {
        now: now.clone(),
        idle: Rc::new(Cell::new(0)),
        front: Rc::new(Cell::new("code.exe")),
    };
    let mut r = Runner::new(
        NoIdle(inner),
        engine(),
        Store::in_memory().unwrap(),
        "d".into(),
        Arc::new(AtomicU64::new(0)),
        Config::default(),
    );
    for _ in 0..30 {
        now.set(now.get() + 1000);
        r.tick().unwrap();
    }
    r.stop().unwrap();
    let rows = r.store().events_between(0, i64::MAX).unwrap();
    assert_eq!(rows.iter().filter(|e| e.kind == "degraded").count(), 1);
}

// ---- pause, tray control, clean stop ----

#[test]
fn pause_records_a_paused_interval_and_nothing_else_until_resume() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    let s = e.step(2000, Signal::Pause);
    assert_eq!(closes(&s.ops), 1);
    assert!(
        s.ops
            .iter()
            .any(|o| matches!(o, Op::Open { kind, source, .. } if kind == "paused" && *source == SRC_AGENT))
    );
    assert!(e.paused());
    // while paused: no app, no lock, no stall record even after an hour
    assert!(e.step(3000, fg("chrome.exe")).ops.is_empty());
    assert!(e.step(4000, Signal::Session(SessionEvt::Lock)).ops.is_empty());
    assert!(e.step(3_600_000, Signal::Tick).ops.is_empty());
    let s = e.step(3_700_000, Signal::Resume);
    assert!(
        s.ops.contains(&Op::Close {
            id: "id2".into(),
            ts: 3_700_000
        }),
        "{:?}",
        s.ops
    );
    assert!(s.refresh_foreground && !e.paused());
}

#[test]
fn pause_survives_a_restart() {
    let now = Rc::new(Cell::new(1_000_000_000_000i64));
    let dir = std::env::temp_dir().join(format!("rhen-watch-pause-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("p.db");
    let _ = std::fs::remove_file(&path);
    {
        let mut r = fake(&now, Config::default(), Store::open(&path).unwrap());
        r.start().unwrap();
        r.handle(Raw::Control(crate::runner::Control::Pause)).unwrap();
        assert_eq!(r.state(), "paused");
        r.stop().unwrap();
    }
    now.set(now.get() + 60_000);
    let mut r = fake(&now, Config::default(), Store::open(&path).unwrap());
    r.start().unwrap();
    assert_eq!(r.state(), "paused", "a reboot must not silently start recording again");
    r.handle(Raw::Control(crate::runner::Control::Resume)).unwrap();
    assert_eq!(r.state(), "recording");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_final_write_that_cannot_be_made_is_reported() {
    let now = Rc::new(Cell::new(1_000_000_000_000i64));
    let mut store = Store::in_memory().unwrap();
    store.fail_next = 10_000;
    let mut r = fake(&now, Config::default(), store);
    r.start().unwrap();
    assert_eq!(r.state(), "degraded");
    let err = r.stop().unwrap_err();
    assert!(err.contains("could not be written"), "{err}");
}

#[test]
fn while_paused_signals_are_not_even_resolved() {
    let now = Rc::new(Cell::new(1_000_000_000_000i64));
    let mut r = fake(&now, Config::default(), Store::in_memory().unwrap());
    r.start().unwrap();
    r.handle(Raw::Control(crate::runner::Control::Pause)).unwrap();
    r.handle(Raw::Foreground(1)).unwrap();
    r.handle(Raw::Session(SessionEvt::Lock)).unwrap();
    r.stop().unwrap();
    let rows = r.store().events_between(0, i64::MAX).unwrap();
    assert!(
        !rows
            .iter()
            .any(|e| e.kind == "locked" || (e.source == "foreground" && e.attrs["exe"] == "chrome.exe")),
        "{rows:?}"
    );
    assert!(rows.iter().any(|e| e.kind == "paused"));
}

#[test]
fn agent_running_follows_the_run_lock() {
    let dir = std::env::temp_dir().join(format!("rhen-watch-lock-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    assert!(!crate::cli::agent_running(&dir), "no lock file: not running");
    let f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dir.join("run.lock"))
        .unwrap();
    assert!(!crate::cli::agent_running(&dir), "file present but unlocked: not running");
    f.try_lock().unwrap();
    assert!(crate::cli::agent_running(&dir), "lock held: running");
    drop(f);
    assert!(!crate::cli::agent_running(&dir));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_metrics_write_is_retried_next_tick_and_never_ends_the_agent() {
    let now = Rc::new(Cell::new(1_000_000_000_000i64));
    let store = Store::in_memory().unwrap();
    store.fail_metric_next.set(2);
    let mut r = fake(&now, Config::default(), store);
    r.start().unwrap();
    now.set(now.get() + 60_000);
    r.tick().unwrap(); // minute boundary: first failure is not an error
    assert_eq!(r.state(), "degraded");
    assert!(r.store().metrics_between(0, i64::MAX).unwrap().is_empty());
    now.set(now.get() + 1000);
    r.tick().unwrap(); // second failure, same spell
    now.set(now.get() + 1000);
    r.tick().unwrap(); // third try succeeds
    let rows = r.store().metrics_between(0, i64::MAX).unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0].events > 0, "the counters were kept: {rows:?}");
    assert_eq!(r.state(), "recording");
    assert_eq!(r.warnings(), 1, "one warning for the whole spell");
}

#[test]
fn a_failed_daily_purge_is_retried_after_a_minute_and_never_ends_the_agent() {
    let day = 86_400_000i64;
    let now = Rc::new(Cell::new(200 * day + 1000));
    let mut store = Store::in_memory().unwrap();
    store
        .apply(
            "d",
            &[
                open_iv("old", 0),
                Op::Close {
                    id: "old".into(),
                    ts: 1000,
                },
            ],
            0,
        )
        .unwrap();
    store.fail_purge_next.set(2);
    let cfg = Config::parse("[retention]\nevents = 30\n").unwrap();
    let mut r = fake(&now, cfg, store);
    r.tick().unwrap();
    now.set(now.get() + 60_000);
    r.tick().unwrap();
    assert_eq!(r.store().events_between(0, 100).unwrap().len(), 1, "still failing, row kept");
    assert_eq!(r.state(), "degraded");
    now.set(now.get() + 60_000);
    r.tick().unwrap();
    assert_eq!(r.store().events_between(0, 100).unwrap().len(), 0, "purged on the retry");
    assert_eq!(r.state(), "recording");
    assert_eq!(r.warnings(), 1);
}

/// A real file with another connection holding the write lock, as a backup tool or a second reader would.
fn locked_db(name: &str) -> (std::path::PathBuf, rusqlite::Connection, Store) {
    let dir = std::env::temp_dir().join(format!("rhen-watch-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("busy.db");
    let store = Store::open(&path).unwrap();
    let other = rusqlite::Connection::open(&path).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    (dir, other, store)
}

#[test]
fn a_busy_database_does_not_stall_best_effort_work_for_the_full_timeout() {
    use std::time::{Duration, Instant};
    let (dir, other, store) = locked_db("busy-best-effort");
    let row = crate::store::MetricRow::default();
    let t = Instant::now();
    assert!(store.best_effort(|s| s.put_metric(&row)).is_err());
    assert!(store.best_effort(|s| s.purge_events_before(1)).is_err());
    assert!(t.elapsed() < Duration::from_secs(2), "took {:?}", t.elapsed());
    // Outside best-effort work the long wait is back: the lock below is released after 1 s, so it succeeds.
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(1));
        drop(other);
    });
    assert!(store.put_metric(&row).is_ok(), "event writes still wait out a short lock");
    release.join().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failing_purge_is_not_retried_every_tick() {
    let day = 86_400_000i64;
    let now = Rc::new(Cell::new(200 * day + 1000));
    let store = Store::in_memory().unwrap();
    store.fail_purge_next.set(10_000);
    let cfg = Config::parse("[retention]\nevents = 30\n").unwrap();
    let mut r = fake(&now, cfg, store);
    for _ in 0..30 {
        r.tick().unwrap();
        now.set(now.get() + 1000);
    }
    assert_eq!(10_000 - r.store().fail_purge_next.get(), 1, "one attempt in the first 30 s");
    for _ in 0..60 {
        r.tick().unwrap();
        now.set(now.get() + 1000);
    }
    assert_eq!(10_000 - r.store().fail_purge_next.get(), 2, "the next attempt waits a minute");
}

#[test]
fn metrics_and_purge_failures_never_reach_the_give_up_limit() {
    let day = 86_400_000i64;
    let now = Rc::new(Cell::new(200 * day + 1000));
    let store = Store::in_memory().unwrap();
    store.fail_metric_next.set(100_000);
    store.fail_purge_next.set(100_000);
    let cfg = Config::parse("[retention]\nevents = 30\n").unwrap();
    let mut r = fake(&now, cfg, store);
    r.start().unwrap();
    for _ in 0..300 {
        now.set(now.get() + 1000);
        r.tick().expect("a metrics or purge failure must never end the agent");
    }
    assert_eq!(r.state(), "degraded");
    assert!(r.store().fail_metric_next.get() < 100_000 - 60, "metrics were retried");
}
