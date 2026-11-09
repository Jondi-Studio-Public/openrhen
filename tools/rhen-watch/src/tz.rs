//! Local time as a function of the instant. A day is local midnight to the next local midnight, each end
//! with its own offset, so the day DST changes is 23 or 25 hours long and a day in the other regime gets its
//! own offset rather than the one in force now.

use std::sync::Arc;

use crate::model::Ms;

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;

/// Minutes east of UTC at a UTC instant.
#[derive(Clone)]
pub struct TzOffset {
    f: Arc<dyn Fn(Ms) -> i32 + Send + Sync>,
}

impl std::fmt::Debug for TzOffset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TzOffset")
    }
}

impl TzOffset {
    pub fn fixed(minutes: i32) -> Self {
        Self::from_fn(move |_| minutes)
    }

    pub fn from_fn(f: impl Fn(Ms) -> i32 + Send + Sync + 'static) -> Self {
        Self { f: Arc::new(f) }
    }

    pub fn offset_at(&self, utc: Ms) -> i32 {
        (self.f)(utc)
    }

    /// The local day number (days since 1970-01-01 on the local calendar) that a UTC instant falls in.
    pub fn day_of(&self, utc: Ms) -> i64 {
        (utc + i64::from(self.offset_at(utc)) * MINUTE_MS).div_euclid(DAY_MS)
    }

    /// The UTC instant of local midnight at the start of local day `day`. When that midnight happens twice
    /// the first is taken; when it never happens (the clock jumps over it) the day starts at the jump.
    pub fn day_start(&self, day: i64) -> Ms {
        let local = day * DAY_MS;
        let before = self.offset_at(local - DAY_MS);
        let after = self.offset_at(local + DAY_MS);
        let valid = [before, after]
            .into_iter()
            .map(|o| local - i64::from(o) * MINUTE_MS)
            .filter(|&t| t + i64::from(self.offset_at(t)) * MINUTE_MS == local)
            .min();
        valid.unwrap_or(local - i64::from(before) * MINUTE_MS)
    }

    /// `[from, to)` in UTC for local day `day`.
    pub fn day_window(&self, day: i64) -> (Ms, Ms) {
        (self.day_start(day), self.day_start(day + 1))
    }
}

/// Pacific/Auckland rules for 2025-2027 (daylight time from the last Sunday of September 02:00 to the first
/// Sunday of April 03:00), as a test fixture.
#[cfg(test)]
pub fn auckland() -> TzOffset {
    use crate::cli::days_from_civil;
    let at = |y, m, d| days_from_civil(y, m, d) * DAY_MS + 14 * 3_600_000;
    // Transition instants, all at 14:00 UTC on the previous calendar day.
    let spans = [
        (at(2025, 9, 27), at(2026, 4, 4)),
        (at(2026, 9, 26), at(2027, 4, 3)),
        (at(2024, 9, 28), at(2025, 4, 5)),
    ];
    TzOffset::from_fn(move |utc| {
        if spans.iter().any(|&(s, e)| utc >= s && utc < e) {
            13 * 60
        } else {
            12 * 60
        }
    })
}
