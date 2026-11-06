//! Tests of the pure rules, run on any OS. The Windows layer is compiled on windows-latest in CI and
//! exercised by the manual run in README.md.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;

use crate::categories::{Catalogue, is_shell_class};
use crate::config::Config;
use crate::engine::{Engine, Fg, PowerEvt, SessionEvt, Settings, Signal};
use crate::model::{Op, SRC_AGENT, attrs};
use crate::report::{ReportInput, build};
use crate::runner::{Raw, Runner, Sys};
use crate::store::Store;

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
    assert!(is_shell_class("shell_traywnd") && !is_shell_class("Chrome_WidgetWin_1"));
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
    assert!(e.step(10_000, Signal::Idle(500_000)).ops.is_empty());
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
    let s = e.step(t0 + 130_000, Signal::Idle(125_000));
    let Op::Open { ts, kind, .. } = &s.ops[0] else { panic!() };
    assert_eq!((kind.as_str(), *ts), ("idle", t0 + 5_000));
    for i in 14..=19 {
        e.step(t0 + i * 10_000, Signal::Tick);
    }
    let s = e.step(t0 + 200_000, Signal::Idle(1_000));
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
    assert!(e.step(4, Signal::Idle(10_000_000)).ops.is_empty());
}

#[test]
fn extra_games_and_categories_come_from_config() {
    let cfg = Config::parse("extra_games = [\"MyGame.exe\"]\n[categories]\n\"Foo.exe\" = \"editor\"\n").unwrap();
    let c = Catalogue::new(&cfg.categories, &cfg.extra_games);
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
    assert_eq!(crate::retention::purge(&s, &permanent, 101 * day).unwrap(), (0, 0));
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
    let text = build(
        r.store(),
        &ReportInput {
            label: "test",
            from,
            to: from + 86_400_000,
            open_until: now.get(),
            offset_min: 0,
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
        assert_eq!(crate::civil_from_days(crate::days_from_civil(y, m, d)), (y, m, d));
    }
    assert_eq!(crate::days_from_civil(1970, 1, 1), 0);
}

#[test]
fn report_on_an_empty_database_says_so() {
    let s = Store::in_memory().unwrap();
    let text = build(
        &s,
        &ReportInput {
            label: "2026-01-01",
            from: 0,
            to: 86_400_000,
            open_until: 0,
            offset_min: 60,
        },
    )
    .unwrap();
    assert!(text.contains("Nothing was captured"));
    assert!(text.contains("UTC+01:00"));
}
