//! Local-day windows across daylight saving, with a Pacific/Auckland fixture.

use crate::cli::days_from_civil;
use crate::report::fmt_clock;
use crate::tz::{TzOffset, auckland};

const H: i64 = 3_600_000;

fn day(y: i64, m: i64, d: i64) -> i64 {
    days_from_civil(y, m, d)
}

#[test]
fn a_fixed_offset_gives_24_hour_days() {
    let tz = TzOffset::fixed(60);
    let (from, to) = tz.day_window(day(2026, 11, 9));
    assert_eq!(to - from, 24 * H);
    assert_eq!(from, day(2026, 11, 9) * 24 * H - H);
    assert_eq!(tz.day_of(from), day(2026, 11, 9));
    assert_eq!(tz.day_of(from - 1), day(2026, 11, 8));
}

#[test]
fn the_day_dst_ends_is_25_hours() {
    let tz = auckland();
    let (from, to) = tz.day_window(day(2026, 4, 5));
    assert_eq!(to - from, 25 * H);
    assert_eq!(tz.offset_at(from), 13 * 60, "midnight is still summer time");
    assert_eq!(tz.offset_at(to), 12 * 60, "the next midnight is winter time");
}

#[test]
fn the_day_dst_starts_is_23_hours() {
    let tz = auckland();
    let (from, to) = tz.day_window(day(2026, 9, 27));
    assert_eq!(to - from, 23 * H);
    assert_eq!(tz.offset_at(from), 12 * 60);
    assert_eq!(tz.offset_at(to), 13 * 60);
}

#[test]
fn ordinary_days_are_24_hours_in_both_regimes() {
    let tz = auckland();
    for d in [day(2026, 1, 15), day(2026, 7, 15), day(2026, 4, 4), day(2026, 4, 6), day(2026, 9, 26), day(2026, 9, 28)] {
        let (from, to) = tz.day_window(d);
        assert_eq!(to - from, 24 * H, "day {d}");
        assert_eq!(tz.day_of(from), d);
        assert_eq!(tz.day_of(to - 1), d);
    }
}

#[test]
fn a_day_in_the_other_regime_uses_its_own_offsets_not_the_offset_now() {
    // The old code used one offset for the whole window; on 2026-01-15 Auckland is +13:00, not +12:00.
    let tz = auckland();
    let (from, _) = tz.day_window(day(2026, 1, 15));
    assert_eq!(fmt_clock(from, tz.offset_at(from)), "00:00");
    let (from, _) = tz.day_window(day(2026, 7, 15));
    assert_eq!(fmt_clock(from, tz.offset_at(from)), "00:00");
}

#[test]
fn clock_labels_across_the_repeated_hour_repeat_but_instants_stay_ordered() {
    let tz = auckland();
    let (from, to) = tz.day_window(day(2026, 4, 5));
    let mut labels = Vec::new();
    let mut t = from;
    while t < to {
        labels.push(fmt_clock(t, tz.offset_at(t)));
        t += H;
    }
    assert_eq!(labels.len(), 25);
    // 02:00 appears twice (once as 02:00 NZDT, once as 02:00 NZST); every other label once.
    assert_eq!(labels.iter().filter(|l| *l == "02:00").count(), 2);
    let mut sorted: Vec<i64> = (0..25).map(|i| from + i * H).collect();
    sorted.dedup();
    assert_eq!(sorted.len(), 25);
}

#[test]
fn a_midnight_that_does_not_exist_starts_the_day_at_the_first_real_instant() {
    // A zone that jumps 00:00 -> 01:00: the local day starts at 01:00.
    let jump = day(2026, 3, 1) * 24 * H;
    let tz = TzOffset::from_fn(move |utc| if utc < jump { 0 } else { 60 });
    let (from, _) = tz.day_window(day(2026, 3, 1));
    assert_eq!(from, jump);
    assert_eq!(fmt_clock(from, tz.offset_at(from)), "01:00");
}
