//! The input meter: how much of each minute the agent watched and how much of it had input, per foreground
//! exe. Pure: no clock, no OS. The runner hands it the numbers one poll at a time.
//!
//! It reads nothing but "how long ago was the last input" (the value the idle probe already reads), so it
//! knows when input happened, never what. Credit is by *instant*: a slot is input-bearing when the last-input
//! instant is later than the previous poll's by more than the tick resolution plus jitter, so one keypress
//! just before a poll credits the slot ending there and not the next one as well.

use std::collections::BTreeMap;

use crate::model::{Ms, Op};

/// An input-bearing slot is credited at most this much, whatever its length.
pub const CREDIT_CAP_MS: i64 = 5_000;
/// The last-input instant must move by more than this to count (tick resolution is about 15.6 ms, plus jitter).
pub const INPUT_TOLERANCE_MS: i64 = 50;
/// A slot whose wall and monotonic lengths differ by more than this is discarded as unobserved.
pub const CLOCK_TOLERANCE_MS: i64 = 2_000;
const MINUTE_MS: i64 = 60_000;

/// `GetTickCount` minus the last-input tick, both 32-bit: the wrapping difference is right across the 49.7-day wrap.
pub fn idle_from_ticks(tick: u32, last: u32) -> u64 {
    u64::from(tick.wrapping_sub(last))
}

#[derive(Debug, Clone, Copy)]
struct Baseline {
    wall: Ms,
    mono: i64,
    last_input: i64,
}

/// (observed_ms, input_ms) per (minute start, exe) within the current run.
type Tally = BTreeMap<(Ms, String), (i64, i64)>;

#[derive(Debug)]
pub struct Meter {
    /// The tally generation. Bumped by every `reset()` so a restart, or a wall clock that steps back inside one
    /// process, writes to a new key and never overwrites earlier values. Readers `SUM` over it.
    run: u64,
    /// The run last announced in an `Op::Meta`, so the announcement rides with the first bucket of a run.
    persisted_run: u64,
    base: Option<Baseline>,
    tallies: Tally,
}

impl Meter {
    /// `run_base` is the highest run already stored.
    pub fn new(run_base: u64) -> Self {
        Self {
            run: run_base,
            persisted_run: run_base,
            base: None,
            tallies: Tally::new(),
        }
    }

    pub fn set_run_base(&mut self, run_base: u64) {
        self.run = run_base;
        self.persisted_run = run_base;
    }

    pub fn run(&self) -> u64 {
        self.run
    }

    /// Forget the baseline and start a new run. After this the first poll sets the baseline and credits nothing.
    /// Called from named engine paths (start, pause, resume, lock or suspend and their release, stall, clock
    /// jump, entering and leaving a suppressed game), never inferred.
    pub fn reset(&mut self) {
        self.base = None;
        self.tallies.clear();
        self.run += 1;
    }

    /// One poll. `wall` is the wall clock, `mono` a monotonic clock, `idle_ms` the time since the last input,
    /// all at the same instant. `limit_ms` is the longest slot that is trusted. Returns the upserts for what
    /// this poll touched (absolute values for the run so far), led by the `run_seq` note when the run is new.
    pub fn sample(&mut self, wall: Ms, mono: i64, idle_ms: u64, exe: &str, limit_ms: i64) -> Vec<Op> {
        let now = Baseline {
            wall,
            mono,
            last_input: mono - idle_ms as i64,
        };
        let Some(prev) = self.base.replace(now) else {
            return Vec::new();
        };
        let slot = now.mono - prev.mono;
        if slot <= 0 || slot > limit_ms || ((now.wall - prev.wall) - slot).abs() > CLOCK_TOLERANCE_MS {
            return Vec::new();
        }
        let credit = if now.last_input > prev.last_input + INPUT_TOLERANCE_MS {
            slot.min(CREDIT_CAP_MS)
        } else {
            0
        };
        // The slot covers wall time [start, wall); share it between the minutes it touches.
        let start = wall - slot;
        let first = start.div_euclid(MINUTE_MS) * MINUTE_MS;
        let last = (wall - 1).div_euclid(MINUTE_MS) * MINUTE_MS;
        let mut touched = Vec::new();
        let mut credit_left = credit;
        let mut minute = first;
        while minute <= last {
            let overlap = (wall.min(minute + MINUTE_MS) - start.max(minute)).max(0);
            let share = if minute == last { credit_left } else { credit * overlap / slot };
            credit_left -= share;
            let t = self.tallies.entry((minute, exe.to_string())).or_default();
            t.0 += overlap;
            t.1 += share;
            touched.push(minute);
            minute += MINUTE_MS;
        }
        // Nothing older than the previous minute can be touched again.
        self.tallies.retain(|(m, _), _| *m >= first - MINUTE_MS);
        let mut ops = self.announce();
        for ((m, e), (obs, inp)) in self.tallies.iter().filter(|((m, e), _)| touched.contains(m) && e == exe) {
            ops.push(self.bucket(*m, e, *obs, *inp));
        }
        ops
    }

    /// Re-emit everything held (idempotent upserts); used when the agent pauses or stops.
    pub fn flush(&mut self) -> Vec<Op> {
        if self.tallies.is_empty() {
            return Vec::new();
        }
        let mut ops = self.announce();
        for ((m, e), (obs, inp)) in &self.tallies {
            ops.push(self.bucket(*m, e, *obs, *inp));
        }
        ops
    }

    fn announce(&mut self) -> Vec<Op> {
        if self.run == self.persisted_run {
            return Vec::new();
        }
        self.persisted_run = self.run;
        vec![Op::Meta {
            key: "run_seq".into(),
            value: self.run.to_string(),
        }]
    }

    fn bucket(&self, minute_ts: Ms, exe: &str, observed_ms: i64, input_ms: i64) -> Op {
        Op::Bucket {
            minute_ts,
            exe: exe.to_string(),
            run: self.run,
            observed_ms,
            input_ms,
        }
    }
}
