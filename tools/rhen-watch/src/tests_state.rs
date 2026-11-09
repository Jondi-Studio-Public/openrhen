//! Engine state truth: what the agent believes about lock, remote, suspend, games and pause must match the
//! machine, including after an agent start, a lost signal or a clock step.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::categories::{Catalogue, is_shell_window};
use crate::config::{self, Config};
use crate::engine::{Engine, Fg, PowerEvt, SessionEvt, Settings, Signal};
use crate::model::{Ms, Op};
use crate::runner::{Control, Runner, Sys};
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

fn open_kinds(ops: &[Op]) -> Vec<(String, Ms)> {
    ops.iter()
        .filter_map(|o| {
            if let Op::Open { kind, ts, .. } = o {
                Some((kind.clone(), *ts))
            } else {
                None
            }
        })
        .collect()
}

fn close_count(ops: &[Op]) -> usize {
    ops.iter().filter(|o| matches!(o, Op::Close { .. })).count()
}

// ---- RW-13: a backward clock step keeps the lock ----

#[test]
fn a_backward_clock_step_while_locked_keeps_the_lock() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    e.step(2000, Signal::Session(SessionEvt::Lock));
    e.step(3000, Signal::Tick);
    let s = e.step(0, Signal::Tick);
    assert_eq!(
        open_kinds(&s.ops),
        [("locked".to_string(), 0)],
        "the lock is reopened at the new time"
    );
    assert!(!s.refresh_foreground, "still held: nothing to look up");
    assert!(!e.polling_allowed());
    // The lock screen is in front: neither it nor an idle sample may record anything.
    assert!(e.step(1000, fg("lockapp.exe")).ops.is_empty());
    assert!(
        e.step(
            2000,
            Signal::Idle {
                idle_ms: 500_000,
                mono_ms: 2000
            }
        )
        .ops
        .is_empty()
    );
    let s = e.step(600_000, Signal::Session(SessionEvt::Unlock));
    assert_eq!(close_count(&s.ops), 1, "the reopened lock is closed by the unlock");
    assert!(s.refresh_foreground);
}

#[test]
fn a_backward_clock_step_while_suspended_keeps_the_suspend() {
    let mut e = engine();
    e.step(1000, Signal::Power(PowerEvt::Suspend));
    e.step(3000, Signal::Tick);
    let s = e.step(0, Signal::Tick);
    assert_eq!(open_kinds(&s.ops), [("suspended".to_string(), 0)]);
    assert!(!s.refresh_foreground);
}

#[test]
fn a_backward_clock_step_when_not_held_still_refreshes_the_foreground() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    e.step(3000, Signal::Tick);
    assert!(e.step(0, Signal::Tick).refresh_foreground);
}

// ---- RW-14: idle never backdates into a game ----

/// Ticks every 10 s from `from` to `to`, so the gap between steps is never taken for a stall.
fn tick_until(e: &mut Engine, from: Ms, to: Ms) {
    let mut t = from;
    while t < to {
        t = (t + 10_000).min(to);
        e.step(t, Signal::Tick);
    }
}

#[test]
fn idle_does_not_backdate_into_a_game_that_has_left_the_foreground() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    e.step(10_000, fg("valorant-win64-shipping.exe"));
    tick_until(&mut e, 10_000, 3_599_000);
    e.step(3_600_000, fg("code.exe"));
    let s = e.step(
        3_601_000,
        Signal::Idle {
            idle_ms: 3_590_000,
            mono_ms: 3_601_000,
        },
    );
    for (kind, ts) in open_kinds(&s.ops) {
        assert!(kind != "idle" || ts >= 3_600_000, "idle opened inside the game at {ts}");
    }
}

#[test]
fn idle_does_not_backdate_into_a_game_that_has_just_started() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    tick_until(&mut e, 1000, 500_000);
    e.step(500_000, fg("valorant-win64-shipping.exe"));
    tick_until(&mut e, 500_000, 999_000);
    e.step(1_000_000, fg("code.exe"));
    let s = e.step(
        1_001_000,
        Signal::Idle {
            idle_ms: 900_000,
            mono_ms: 1_001_000,
        },
    );
    assert!(open_kinds(&s.ops).iter().all(|(k, ts)| k != "idle" || *ts >= 1_000_000));
}

// ---- RW-22: the lock screen is part of the lock ----

#[test]
fn the_lock_screen_host_is_a_shell_window() {
    assert!(is_shell_window("Windows.UI.Core.CoreWindow", Some("lockapp.exe")));
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    let s = e.step(
        2000,
        Signal::Foreground(Fg {
            class: "Windows.UI.Core.CoreWindow".into(),
            exe: Some("lockapp.exe".into()),
        }),
    );
    assert!(s.ops.is_empty(), "no app interval for the lock screen");
    // Calculator shares the class and stays an app.
    assert!(!is_shell_window("Windows.UI.Core.CoreWindow", Some("calculatorapp.exe")));
}

// ---- RW-17: extra_games is validated and stored normalised ----

#[test]
fn extra_games_are_trimmed_lowercased_and_stored_as_bare_exe_names() {
    let c = Config::parse("extra_games = [\" Foo.EXE \", \"bar.exe\"]\n").unwrap();
    assert_eq!(c.extra_games, ["foo.exe", "bar.exe"]);
    let cat = Catalogue::new(&HashMap::new(), &c.extra_games);
    assert!(cat.is_game("foo.exe"));
}

#[test]
fn extra_games_with_a_path_or_no_exe_suffix_are_rejected() {
    for bad in ["C:\\\\Games\\\\foo.exe", "games/foo.exe", "Valorant", "", ".exe"] {
        let err = Config::parse(&format!("extra_games = [\"{bad}\"]\n")).unwrap_err();
        assert!(err.contains("extra_games") && err.contains(".exe"), "{bad}: {err}");
    }
    let before = config::TEMPLATE;
    let err = config::set_key(before, "extra_games", "Valorant").unwrap_err();
    assert!(err.contains("extra_games"), "{err}");
}

#[test]
fn catalogue_matches_extra_games_in_any_case() {
    let cat = Catalogue::new(&HashMap::new(), &[" MyGame.EXE ".to_string()]);
    assert!(cat.is_game("mygame.exe"));
}

// ---- RW-12 / RW-23: the runner reads the session and respects pause ----

struct StateSys {
    now: Rc<Cell<Ms>>,
    session: Rc<Cell<(Option<bool>, bool)>>,
    lookups: Rc<Cell<u32>>,
    idle_probes: Rc<Cell<u32>>,
}

impl Sys for StateSys {
    fn now_ms(&self) -> Ms {
        self.now.get()
    }
    fn mono_ms(&self) -> Ms {
        self.now.get()
    }
    fn idle_ms(&self) -> Option<u64> {
        self.idle_probes.set(self.idle_probes.get() + 1);
        Some(500_000)
    }
    fn resolve(&self, _: usize) -> Fg {
        self.current_foreground().unwrap()
    }
    fn current_foreground(&self) -> Option<Fg> {
        self.lookups.set(self.lookups.get() + 1);
        Some(Fg {
            class: "Chrome_WidgetWin_1".into(),
            exe: Some("code.exe".into()),
        })
    }
    fn proc_stats(&self) -> (i64, i64) {
        (0, 0)
    }
    fn session_state(&self) -> (Option<bool>, bool) {
        self.session.get()
    }
}

struct Rig {
    now: Rc<Cell<Ms>>,
    session: Rc<Cell<(Option<bool>, bool)>>,
    lookups: Rc<Cell<u32>>,
    idle_probes: Rc<Cell<u32>>,
    dropped: Arc<AtomicU64>,
    r: Runner<StateSys>,
}

impl Rig {
    fn new(session: (Option<bool>, bool)) -> Self {
        let now = Rc::new(Cell::new(1_000_000_000_000));
        let session = Rc::new(Cell::new(session));
        let lookups = Rc::new(Cell::new(0));
        let idle_probes = Rc::new(Cell::new(0));
        let dropped = Arc::new(AtomicU64::new(0));
        let r = Runner::new(
            StateSys {
                now: now.clone(),
                session: session.clone(),
                lookups: lookups.clone(),
                idle_probes: idle_probes.clone(),
            },
            engine(),
            Store::in_memory().unwrap(),
            "d".into(),
            dropped.clone(),
            Config::default(),
        );
        Rig {
            now,
            session,
            lookups,
            idle_probes,
            dropped,
            r,
        }
    }

    fn run(&mut self, secs: u32) {
        for _ in 0..secs {
            self.now.set(self.now.get() + 1000);
            self.r.tick().unwrap();
        }
    }

    fn kinds(&mut self) -> Vec<String> {
        self.r.stop().unwrap();
        let t = self.now.get();
        self.r
            .store()
            .events_between(t - 86_400_000, t + 86_400_000)
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect()
    }
}

#[test]
fn an_agent_started_while_locked_records_the_lock_not_app_time() {
    let mut rig = Rig::new((Some(true), false));
    rig.r.start().unwrap();
    rig.run(20);
    let kinds = rig.kinds();
    assert!(kinds.contains(&"locked".to_string()), "{kinds:?}");
    assert!(
        !kinds.contains(&"app".to_string()) && !kinds.contains(&"idle".to_string()),
        "{kinds:?}"
    );
}

#[test]
fn an_agent_started_over_remote_desktop_records_remote() {
    let mut rig = Rig::new((Some(false), true));
    rig.r.start().unwrap();
    rig.run(5);
    let kinds = rig.kinds();
    assert!(
        kinds.contains(&"remote".to_string()) && kinds.contains(&"app".to_string()),
        "{kinds:?}"
    );
}

#[test]
fn a_lost_unlock_is_recovered_from_the_real_session_state() {
    let mut rig = Rig::new((Some(true), false));
    rig.r.start().unwrap();
    rig.run(5);
    // The user unlocks, but the Unlock signal is dropped.
    rig.session.set((Some(false), false));
    rig.dropped.store(1, Ordering::Relaxed);
    rig.run(1);
    rig.r.resync_if_pending().unwrap();
    let kinds = rig.kinds();
    assert!(
        kinds.contains(&"locked".to_string()) && kinds.contains(&"app".to_string()),
        "{kinds:?}"
    );
    let t = rig.now.get();
    let rows = rig.r.store().events_between(t - 86_400_000, t + 86_400_000).unwrap();
    assert!(rows.iter().all(|e| e.ts_end.is_some()));
}

#[test]
fn an_unreadable_session_state_changes_nothing() {
    let mut rig = Rig::new((None, false));
    rig.r.start().unwrap();
    rig.run(3);
    let kinds = rig.kinds();
    assert!(
        kinds.contains(&"app".to_string()) && !kinds.contains(&"locked".to_string()),
        "{kinds:?}"
    );
}

#[test]
fn dropped_signals_while_paused_neither_look_up_a_window_nor_write_a_row() {
    let mut rig = Rig::new((Some(false), false));
    rig.r.start().unwrap();
    rig.r.control(Control::Pause).unwrap();
    let before = rig.lookups.get();
    rig.dropped.store(3, Ordering::Relaxed);
    rig.run(2);
    assert_eq!(rig.lookups.get(), before, "no foreground lookup while paused");
    let kinds = rig.kinds();
    assert!(!kinds.contains(&"dropped".to_string()), "{kinds:?}");
}

#[test]
fn a_queued_lock_and_a_dropped_unlock_end_unlocked() {
    let mut rig = Rig::new((Some(false), false));
    rig.r.start().unwrap();
    rig.run(3);
    // The user locked and unlocked; the Lock is still queued, the Unlock was dropped.
    rig.dropped.store(1, Ordering::Relaxed);
    rig.r.handle(crate::runner::Raw::Session(SessionEvt::Lock)).unwrap();
    // The queue is empty now: the tick notices the drop and re-reads the real state, which is unlocked.
    rig.run(1);
    rig.run(5);
    let kinds = rig.kinds();
    assert!(
        kinds.iter().filter(|k| *k == "app").count() >= 2,
        "recording resumed after the unlock: {kinds:?}"
    );
}

#[test]
fn the_resync_waits_for_the_queue_and_happens_once() {
    let mut rig = Rig::new((Some(false), false));
    rig.r.start().unwrap();
    rig.dropped.store(1, Ordering::Relaxed);
    let before = rig.lookups.get();
    rig.run(1);
    assert_eq!(rig.lookups.get(), before + 1);
    rig.r.resync_if_pending().unwrap();
    assert_eq!(rig.lookups.get(), before + 1, "nothing pending the second time");
}

#[test]
fn an_unknown_lock_flag_still_syncs_remote() {
    let mut rig = Rig::new((None, true));
    rig.r.start().unwrap();
    rig.run(3);
    let kinds = rig.kinds();
    assert!(
        kinds.contains(&"remote".to_string()) && !kinds.contains(&"locked".to_string()),
        "{kinds:?}"
    );
}

// ---- a backward clock step keeps remote and display_off too ----

#[test]
fn a_backward_clock_step_keeps_remote_and_display_off_open() {
    let mut e = engine();
    e.step(1000, fg("code.exe"));
    e.step(1500, Signal::Session(SessionEvt::RemoteConnect));
    e.step(2000, Signal::Power(PowerEvt::DisplayOff));
    e.step(3000, Signal::Tick);
    let s = e.step(0, Signal::Tick);
    let opened = open_kinds(&s.ops);
    assert!(
        opened.contains(&("remote".to_string(), 0)) && opened.contains(&("display_off".to_string(), 0)),
        "{opened:?}"
    );
    // They are still tracked: their end events close them.
    assert_eq!(close_count(&e.step(1000, Signal::Session(SessionEvt::RemoteDisconnect)).ops), 1);
    assert_eq!(close_count(&e.step(2000, Signal::Power(PowerEvt::DisplayOn)).ops), 1);
}

#[test]
fn resume_while_locked_records_the_lock() {
    let mut rig = Rig::new((Some(true), false));
    rig.r.start().unwrap();
    rig.run(5);
    rig.r.control(Control::Pause).unwrap();
    rig.run(5);
    rig.r.control(Control::Resume).unwrap();
    rig.run(5);
    let kinds = rig.kinds();
    assert_eq!(kinds.iter().filter(|k| *k == "locked").count(), 2, "{kinds:?}");
    assert!(!kinds.contains(&"app".to_string()), "{kinds:?}");
}

#[test]
fn resume_after_a_lost_unlock_reads_the_real_state() {
    let mut rig = Rig::new((Some(true), false));
    rig.r.start().unwrap();
    rig.run(3);
    rig.r.control(Control::Pause).unwrap();
    rig.session.set((Some(false), false));
    rig.run(3);
    rig.r.control(Control::Resume).unwrap();
    rig.run(3);
    let kinds = rig.kinds();
    assert!(kinds.contains(&"app".to_string()), "{kinds:?}");
}

#[test]
fn a_drop_is_resynced_before_the_idle_probe_in_the_same_tick() {
    let mut rig = Rig::new((Some(false), false));
    rig.r.start().unwrap();
    rig.run(1);
    // The Lock signal is dropped; the real state is locked, and the next probe is due.
    rig.session.set((Some(true), false));
    rig.dropped.store(1, Ordering::Relaxed);
    rig.now.set(rig.now.get() + 6_000);
    let probes = rig.idle_probes.get();
    rig.r.tick().unwrap();
    assert_eq!(rig.idle_probes.get(), probes, "no input sample on stale state");
    let kinds = rig.kinds();
    assert!(kinds.contains(&"locked".to_string()), "{kinds:?}");
}

#[test]
fn an_executable_name_with_a_drive_colon_is_refused() {
    assert!(crate::categories::normalise_exe("c:foo.exe").is_err());
    assert_eq!(crate::categories::normalise_exe("Foo.EXE").unwrap(), "foo.exe");
}
