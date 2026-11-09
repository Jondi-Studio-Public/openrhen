//! Glue between the OS layer, the engine and the store. Generic over `Sys` so it runs against a fake in tests.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;

use crate::config::Config;
use crate::engine::{Engine, Fg, PowerEvt, SessionEvt, Signal};
use crate::model::{Ms, Op, SRC_AGENT, attrs};
use crate::store::{MetricRow, Store};

pub trait Sys {
    fn now_ms(&self) -> Ms;
    /// A monotonic clock, in milliseconds from any fixed origin; the input meter measures slots with it.
    fn mono_ms(&self) -> Ms;
    /// Milliseconds since the last input, or `None` if the OS would not say.
    fn idle_ms(&self) -> Option<u64>;
    fn resolve(&self, hwnd: usize) -> Fg;
    fn current_foreground(&self) -> Option<Fg>;
    /// (process CPU time in ms, working set in bytes) of this agent.
    fn proc_stats(&self) -> (i64, i64);
}

#[derive(Debug, Clone)]
pub enum Raw {
    Foreground(usize),
    Session(SessionEvt),
    Power(PowerEvt),
    Control(Control),
}

/// Commands from the tray menu.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Control {
    Pause,
    Resume,
}

const HEARTBEAT_EVERY_MS: Ms = 30_000;

pub struct Runner<S: Sys> {
    sys: S,
    engine: Engine,
    store: Store,
    device: String,
    dropped: Arc<AtomicU64>,
    dropped_seen: u64,
    last_idle: Ms,
    last_beat: Ms,
    metric_minute: Ms,
    metric_cpu_start: i64,
    metric_events: i64,
    metric_dropped: i64,
    cfg: Config,
    last_purge_day: Ms,
    /// Ops the store refused (busy, disk full); kept and retried so nothing is lost while writes fail.
    pending: Vec<Op>,
    failures: u32,
    idle_unavailable: bool,
    /// `file`, `default` or `degraded`: where the run's category map came from.
    categories: &'static str,
}

/// Consecutive failed writes (about one per second) before the agent gives up.
const MAX_FAILURES: u32 = 60;
const MAX_PENDING: usize = 20_000;

impl<S: Sys> Runner<S> {
    pub fn new(sys: S, engine: Engine, store: Store, device: String, dropped: Arc<AtomicU64>, cfg: Config) -> Self {
        let now = sys.now_ms();
        let cpu = sys.proc_stats().0;
        Self {
            sys,
            engine,
            store,
            device,
            dropped,
            dropped_seen: 0,
            last_idle: now,
            last_beat: now,
            metric_minute: now / 60_000,
            metric_cpu_start: cpu,
            metric_events: 0,
            metric_dropped: 0,
            cfg,
            last_purge_day: -1,
            pending: Vec::new(),
            failures: 0,
            idle_unavailable: false,
            categories: "default",
        }
    }

    /// Say where the category map came from, for the start row.
    pub fn set_categories(&mut self, source: &'static str) {
        self.categories = source;
    }

    #[cfg(test)]
    pub fn store(&self) -> &Store {
        &self.store
    }

    #[cfg(test)]
    pub fn store_mut(&mut self) -> &mut Store {
        &mut self.store
    }

    pub fn start(&mut self) -> Result<(), String> {
        let now = self.sys.now_ms();
        // Tally generations only grow: the highest one stored is the base the engine moves past at start.
        let run_seq = self.store.meta("run_seq").map_err(|e| e.to_string())?;
        self.engine.set_run_base(run_seq.and_then(|v| v.parse().ok()).unwrap_or(0));
        let c = &self.cfg.collectors;
        let retention = &self.cfg.retention;
        let start_attrs = attrs([
            ("idle_threshold_secs", json!(self.cfg.idle_threshold_secs.unwrap_or(120))),
            (
                "collectors",
                json!({"foreground": c.foreground, "idle": c.idle, "session": c.session, "power": c.power}),
            ),
            (
                "retention",
                json!({"events": retention.events, "metrics": retention.metrics, "input_buckets": retention.input_buckets}),
            ),
            ("extra_games", json!(self.cfg.extra_games)),
            ("categories", json!(self.categories)),
        ]);
        // The marker only means something until the next run starts.
        self.apply(
            now,
            vec![
                Op::Meta {
                    key: "clean_stop".into(),
                    value: String::new(),
                },
                Op::Instant {
                    source: SRC_AGENT,
                    kind: "start".into(),
                    ts: now,
                    end: None,
                    attrs: start_attrs,
                },
            ],
        )?;
        self.feed(Signal::Tick)?;
        if self.store.meta("paused").map_err(|e| e.to_string())?.as_deref() == Some("1") {
            return self.feed(Signal::Pause);
        }
        if let Some(fg) = self.sys.current_foreground() {
            self.feed(Signal::Foreground(fg))?;
        }
        Ok(())
    }

    pub fn handle(&mut self, raw: Raw) -> Result<(), String> {
        if self.engine.paused() && !matches!(raw, Raw::Control(_)) {
            // Paused means paused: do not even look the window up.
            return Ok(());
        }
        let signal = match raw {
            Raw::Foreground(hwnd) => Signal::Foreground(self.sys.resolve(hwnd)),
            Raw::Session(e) => Signal::Session(e),
            Raw::Power(e) => Signal::Power(e),
            Raw::Control(c) => return self.control(c),
        };
        self.feed(signal)
    }

    /// `recording`, `paused`, or `degraded` (writes are failing); shown on the tray icon.
    pub fn state(&self) -> &'static str {
        if self.engine.paused() {
            "paused"
        } else if self.failures > 0 {
            "degraded"
        } else {
            "recording"
        }
    }

    pub fn control(&mut self, c: Control) -> Result<(), String> {
        let (signal, flag) = match c {
            Control::Pause => (Signal::Pause, "1"),
            Control::Resume => (Signal::Resume, "0"),
        };
        // Remember it, so a restart or reboot does not silently start recording again.
        self.store.set_meta("paused", flag).map_err(|e| e.to_string())?;
        self.feed(signal)
    }

    /// Called about once a second.
    pub fn tick(&mut self) -> Result<(), String> {
        let now = self.sys.now_ms();
        let dropped = self.dropped.load(Ordering::Relaxed);
        if dropped > self.dropped_seen {
            // Signals were lost: what the agent knows may be stale, so say so and look again.
            let n = (dropped - self.dropped_seen) as i64;
            self.dropped_seen = dropped;
            self.metric_dropped += n;
            self.apply(
                now,
                vec![Op::Instant {
                    source: SRC_AGENT,
                    kind: "dropped".into(),
                    ts: now,
                    end: None,
                    attrs: attrs([("count", json!(n))]),
                }],
            )?;
            if let Some(fg) = self.sys.current_foreground() {
                self.feed(Signal::Foreground(fg))?;
            }
        }
        // A wall clock stepped back must not silence the probe until it catches up: negative means due.
        let since_poll = now - self.last_idle;
        if !(0..self.engine.idle_cadence_ms()).contains(&since_poll) {
            self.last_idle = now;
            if self.engine.polling_allowed() {
                match self.sys.idle_ms() {
                    Some(idle_ms) => {
                        let mono_ms = self.sys.mono_ms();
                        return self.feed_then_beat(Signal::Idle { idle_ms, mono_ms }, now);
                    }
                    None => {
                        if !self.idle_unavailable {
                            // Say so once: silence must not read as "not idle".
                            self.idle_unavailable = true;
                            self.degraded(&["idle".to_string()])?;
                        }
                        // Whatever the unreadable stretch covered is not credited.
                        self.feed(Signal::IdleUnavailable)?;
                    }
                }
            }
        }
        self.feed_then_beat(Signal::Tick, now)
    }

    fn feed_then_beat(&mut self, signal: Signal, now: Ms) -> Result<(), String> {
        self.daily_purge(now)?;
        self.feed(signal)?;
        if !(0..HEARTBEAT_EVERY_MS).contains(&(now - self.last_beat)) {
            self.last_beat = now;
            self.apply(now, vec![])?;
        }
        self.flush_metrics(now)
    }

    /// Clean shutdown: close every interval and note the stop.
    pub fn stop(&mut self) -> Result<(), String> {
        self.finish_run(true)
    }

    /// Close everything after a caught panic. The stop is noted but not marked clean, so the next start
    /// records the downtime as `unknown`.
    pub fn stop_after_panic(&mut self) -> Result<(), String> {
        self.finish_run(false)
    }

    fn finish_run(&mut self, clean: bool) -> Result<(), String> {
        let now = self.sys.now_ms();
        let mut ops = self.engine.finish(now);
        ops.push(Op::Instant {
            source: SRC_AGENT,
            kind: "stop".into(),
            ts: now,
            end: None,
            attrs: Default::default(),
        });
        // Same write as the heartbeat `now`: recovery tells a clean stop from a crash by the two matching.
        if clean {
            ops.push(Op::Meta {
                key: "clean_stop".into(),
                value: now.to_string(),
            });
        }
        self.apply(now, ops)?;
        // The last write matters most: retry it, and say so if it still cannot be made.
        for _ in 0..5 {
            if self.pending.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
            self.apply(now, vec![])?;
        }
        if !self.pending.is_empty() {
            return Err(format!(
                "the final {} records could not be written; the next start will record the gap as unknown",
                self.pending.len()
            ));
        }
        self.flush_metrics(i64::MAX / 2)
    }

    fn feed(&mut self, signal: Signal) -> Result<(), String> {
        let now = self.sys.now_ms();
        let mut step = self.engine.step(now, signal);
        let refresh = step.refresh_foreground;
        let ops = std::mem::take(&mut step.ops);
        self.apply(now, ops)?;
        if refresh && let Some(fg) = self.sys.current_foreground() {
            let step = self.engine.step(now, Signal::Foreground(fg));
            self.apply(now, step.ops)?;
        }
        Ok(())
    }

    fn apply(&mut self, now: Ms, ops: Vec<Op>) -> Result<(), String> {
        self.metric_events += ops.iter().filter(|o| o.is_event_op()).count() as i64;
        self.pending.extend(ops);
        match self.store.apply(&self.device, &self.pending, now) {
            Ok(()) => {
                self.pending.clear();
                self.failures = 0;
                Ok(())
            }
            Err(e) => {
                self.failures += 1;
                if self.failures >= MAX_FAILURES || self.pending.len() > MAX_PENDING {
                    return Err(format!("cannot write to the database ({} failures in a row): {e}", self.failures));
                }
                Ok(())
            }
        }
    }

    /// Record that a collector could not start or keep working.
    pub fn degraded(&mut self, collectors: &[String]) -> Result<(), String> {
        let now = self.sys.now_ms();
        self.apply(
            now,
            vec![Op::Instant {
                source: SRC_AGENT,
                kind: "degraded".into(),
                ts: now,
                end: None,
                attrs: attrs([("collectors", json!(collectors))]),
            }],
        )
    }

    /// Once per UTC day: delete what the retention setting says is old, then shrink the log.
    fn daily_purge(&mut self, now: Ms) -> Result<(), String> {
        let day = now.div_euclid(86_400_000);
        if day == self.last_purge_day {
            return Ok(());
        }
        self.last_purge_day = day;
        let (events, metrics, buckets) = crate::retention::purge(&self.store, &self.cfg, now)?;
        if events + metrics + buckets > 0 {
            let _ = self.store.checkpoint();
        }
        Ok(())
    }

    fn flush_metrics(&mut self, now: Ms) -> Result<(), String> {
        let minute = now / 60_000;
        if minute == self.metric_minute {
            return Ok(());
        }
        let (cpu, rss) = self.sys.proc_stats();
        let row = MetricRow {
            minute_ts: self.metric_minute * 60_000,
            cpu_ms: (cpu - self.metric_cpu_start).max(0),
            rss_bytes: rss,
            db_bytes: self.store.db_bytes(),
            events: self.metric_events,
            dropped: self.metric_dropped,
        };
        self.store.put_metric(&row).map_err(|e| e.to_string())?;
        self.metric_minute = minute;
        self.metric_cpu_start = cpu;
        self.metric_events = 0;
        self.metric_dropped = 0;
        Ok(())
    }
}
