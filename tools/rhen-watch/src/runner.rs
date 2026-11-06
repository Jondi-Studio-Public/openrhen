//! Glue between the OS layer, the engine and the store. Generic over `Sys` so it runs against a fake in tests.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;

use crate::engine::{Engine, Fg, PowerEvt, SessionEvt, Signal};
use crate::model::{Ms, Op, SRC_AGENT, attrs};
use crate::store::{MetricRow, Store};

pub trait Sys {
    fn now_ms(&self) -> Ms;
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
}

const IDLE_EVERY_MS: Ms = 5_000;
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
}

impl<S: Sys> Runner<S> {
    pub fn new(sys: S, engine: Engine, store: Store, device: String, dropped: Arc<AtomicU64>) -> Self {
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
        }
    }

    #[cfg(test)]
    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn start(&mut self) -> Result<(), String> {
        let now = self.sys.now_ms();
        self.apply(
            now,
            vec![Op::Instant {
                source: SRC_AGENT,
                kind: "start".into(),
                ts: now,
                end: None,
                attrs: Default::default(),
            }],
        )?;
        self.feed(Signal::Tick)?;
        if let Some(fg) = self.sys.current_foreground() {
            self.feed(Signal::Foreground(fg))?;
        }
        Ok(())
    }

    pub fn handle(&mut self, raw: Raw) -> Result<(), String> {
        let signal = match raw {
            Raw::Foreground(hwnd) => Signal::Foreground(self.sys.resolve(hwnd)),
            Raw::Session(e) => Signal::Session(e),
            Raw::Power(e) => Signal::Power(e),
        };
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
        if now - self.last_idle >= IDLE_EVERY_MS {
            self.last_idle = now;
            if !self.engine.suppressed()
                && let Some(idle) = self.sys.idle_ms()
            {
                return self.feed_then_beat(Signal::Idle(idle), now);
            }
        }
        self.feed_then_beat(Signal::Tick, now)
    }

    fn feed_then_beat(&mut self, signal: Signal, now: Ms) -> Result<(), String> {
        self.feed(signal)?;
        if now - self.last_beat >= HEARTBEAT_EVERY_MS {
            self.last_beat = now;
            self.apply(now, vec![])?;
        }
        self.flush_metrics(now)
    }

    /// Clean shutdown: close every interval and note the stop.
    pub fn stop(&mut self) -> Result<(), String> {
        let now = self.sys.now_ms();
        let mut ops = self.engine.finish(now);
        ops.push(Op::Instant {
            source: SRC_AGENT,
            kind: "stop".into(),
            ts: now,
            end: None,
            attrs: Default::default(),
        });
        self.apply(now, ops)?;
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
        self.metric_events += ops.len() as i64;
        self.store.apply(&self.device, &ops, now).map_err(|e| e.to_string())
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
