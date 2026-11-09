//! Input stretches, blocks, switch rate and day edges, derived on demand from rows and buckets.

use serde_json::json;

use crate::cli::days_from_civil;
use crate::config::Derive;
use crate::derive::{Availability, Basis, DayFacts, DeriveInput, Params, derive};
use crate::store::{BucketRow, EventRow};
use crate::tz::{TzOffset, auckland};

const MIN: i64 = 60_000;
/// A UTC midnight, far from any boundary that matters.
const DAY0: i64 = 20_000 * 86_400_000;

fn at(k: i64) -> i64 {
    DAY0 + k * MIN
}

fn params() -> Params {
    Params::from(&Derive::default())
}

fn group_of(exe: &str) -> String {
    match exe {
        "code.exe" | "wt.exe" => "work",
        "chrome.exe" => "browser",
        "chat.exe" => "comms",
        "music.exe" => "media",
        _ => "other",
    }
    .to_string()
}

/// A minute of the stated exe with `input_s` seconds of input and a full minute observed.
fn bk(k: i64, exe: &str, input_s: i64) -> BucketRow {
    BucketRow {
        minute_ts: at(k),
        exe: exe.into(),
        observed_ms: 60_000,
        input_ms: input_s * 1000,
    }
}

fn eng(k: i64) -> BucketRow {
    bk(k, "code.exe", 20)
}

fn quiet(k: i64) -> BucketRow {
    bk(k, "code.exe", 0)
}

/// Minutes `from..to` all engaged in `exe`.
fn run(exe: &str, from: i64, to: i64) -> Vec<BucketRow> {
    (from..to).map(|k| bk(k, exe, 20)).collect()
}

/// Quiet but observed minutes `from..to`.
fn calm(from: i64, to: i64) -> Vec<BucketRow> {
    (from..to).map(quiet).collect()
}

fn ev(source: &str, kind: &str, start: i64, end: i64, attrs: serde_json::Value) -> EventRow {
    EventRow {
        id: format!("{source}-{kind}-{start}"),
        ts_start: start,
        ts_end: Some(end),
        source: source.into(),
        kind: kind.into(),
        attrs,
    }
}

fn app(exe: &str, start: i64, end: i64) -> EventRow {
    ev("foreground", "app", start, end, json!({"exe": exe, "category": "x"}))
}

fn facts_with(buckets: &[BucketRow], events: &[EventRow], from: i64, to: i64, p: &Params) -> DayFacts {
    facts_until(buckets, events, from, to, to, None, p)
}

fn facts_until(
    buckets: &[BucketRow],
    events: &[EventRow],
    from: i64,
    to: i64,
    open_until: i64,
    floor: Option<i64>,
    p: &Params,
) -> DayFacts {
    derive(&DeriveInput {
        from,
        to,
        events,
        buckets,
        group_of: &group_of,
        params: p,
        open_until,
        events_floor: floor,
    })
}

/// One window, `at(0)` to `at(24 * 60)`, and one filler event so the events are not "purged".
fn facts(buckets: &[BucketRow], extra: &[EventRow]) -> DayFacts {
    let mut events = vec![app("code.exe", at(0), at(24 * 60))];
    events.extend_from_slice(extra);
    facts_with(buckets, &events, at(0), at(24 * 60), &params())
}

fn sessions_of(f: &DayFacts) -> Vec<(i64, i64)> {
    f.sessions.iter().map(|s| ((s.start - DAY0) / MIN, (s.end - DAY0) / MIN)).collect()
}

// ---- sessions ----

#[test]
fn gaps_of_4_and_5_empty_minutes_join_and_6_splits() {
    // engaged at minute 100 and 100 + empty + 1
    for (empty, joined) in [(4, true), (5, true), (6, false)] {
        let mut b = vec![eng(100)];
        b.extend(calm(101, 101 + empty));
        b.push(eng(101 + empty));
        let f = facts(&b, &[]);
        assert_eq!(f.sessions.len(), if joined { 1 } else { 2 }, "{empty} empty minutes");
    }
}

#[test]
fn an_interruption_inside_a_short_gap_splits_the_session() {
    let mut b = vec![eng(100)];
    b.extend(calm(101, 103));
    b.push(eng(103));
    assert_eq!(facts(&b, &[]).sessions.len(), 1);
    let lock = ev("session", "locked", at(101) + 10_000, at(102) + 10_000, json!({}));
    assert_eq!(facts(&b, &[lock]).sessions.len(), 2);
    for (src, kind) in [
        ("power", "suspended"),
        ("agent", "paused"),
        ("agent", "unknown"),
        ("foreground", "suppressed"),
    ] {
        let e = ev(src, kind, at(101) + 5_000, at(102), json!({}));
        assert_eq!(facts(&b, &[e]).sessions.len(), 2, "{src}/{kind}");
    }
    let jump = ev("agent", "clock_jump", at(102), at(102), json!({}));
    assert_eq!(facts(&b, &[jump]).sessions.len(), 2, "an instant interruption counts");
    // an interruption outside the gap does not
    let far = ev("session", "locked", at(300), at(310), json!({}));
    assert_eq!(facts(&b, &[far]).sessions.len(), 1);
    // idle and display-off are not interruptions
    let idle = ev("idle", "idle", at(101), at(102), json!({}));
    let off = ev("power", "display_off", at(101), at(102), json!({}));
    assert_eq!(facts(&b, &[idle, off]).sessions.len(), 1);
}

#[test]
fn an_unobserved_minute_splits_and_so_does_a_minute_observed_under_30_seconds() {
    let mut b = vec![eng(100), quiet(101)];
    b.push(eng(103)); // minute 102 has no bucket at all
    assert_eq!(facts(&b, &[]).sessions.len(), 2, "no row means nobody watched");
    let mut thin = bk(102, "code.exe", 0);
    thin.observed_ms = 29_000;
    let b = vec![eng(100), quiet(101), thin.clone(), eng(103)];
    assert_eq!(facts(&b, &[]).sessions.len(), 2);
    thin.observed_ms = 30_000;
    let b = vec![eng(100), quiet(101), thin, eng(103)];
    assert_eq!(facts(&b, &[]).sessions.len(), 1, "30 s observed counts as observed");
}

#[test]
fn engaged_means_enough_seconds_of_input_in_the_minute() {
    let b = vec![bk(100, "code.exe", 9), bk(101, "code.exe", 10)];
    let f = facts(&b, &[]);
    assert_eq!(f.engaged_minutes, 1);
    // input from several exes in one minute adds up
    let b = vec![bk(100, "code.exe", 6), bk(100, "chrome.exe", 5)];
    assert_eq!(facts(&b, &[]).engaged_minutes, 1);
    let mut p = params();
    p.engaged_input_seconds = 20;
    let f = facts_with(&[bk(100, "code.exe", 15)], &[app("code.exe", at(0), at(1440))], at(0), at(1440), &p);
    assert_eq!(f.engaged_minutes, 0);
}

#[test]
fn a_minutes_group_is_the_group_with_most_input() {
    let b = vec![bk(100, "code.exe", 4), bk(100, "chrome.exe", 9)];
    let f = facts(&b, &[]);
    assert_eq!(
        f.other_stretches.len() + f.blocks.len(),
        0,
        "one engaged minute is too short for a block"
    );
    let mut p = params();
    p.min_block_minutes = 1;
    p.detour_minutes = 1;
    let f = facts_with(&b, &[app("code.exe", at(0), at(1440))], at(0), at(1440), &p);
    assert_eq!(f.blocks[0].group, "browser");
}

// ---- blocks ----

fn block_params(min_block: u32, detour: u32, share: u32) -> Params {
    let mut p = params();
    p.min_block_minutes = min_block;
    p.detour_minutes = detour;
    p.detour_share_percent = share;
    p
}

fn blocks_of(b: &[BucketRow], p: &Params) -> DayFacts {
    facts_with(b, &[app("code.exe", at(0), at(1440))], at(0), at(1440), p)
}

#[test]
fn a_short_visit_to_another_group_is_absorbed_but_not_counted_active() {
    let mut b = run("code.exe", 100, 106);
    b.extend(run("chat.exe", 106, 108));
    b.extend(run("code.exe", 108, 114));
    let f = blocks_of(&b, &params());
    assert_eq!(f.blocks.len(), 1);
    let blk = &f.blocks[0];
    assert_eq!(
        (
            blk.group.as_str(),
            blk.active_minutes,
            blk.span_minutes,
            blk.detours,
            blk.detour_minutes
        ),
        ("work", 12, 14, 1, 2)
    );
    assert_eq!(blk.density_percent(), 85);
    assert!(!blk.loose());
    assert_eq!(((blk.start - DAY0) / MIN, (blk.end - DAY0) / MIN), (100, 114));
}

#[test]
fn a_longer_visit_is_not_absorbed() {
    let mut b = run("code.exe", 100, 112);
    b.extend(run("chat.exe", 112, 115));
    b.extend(run("code.exe", 115, 127));
    let f = blocks_of(&b, &params());
    assert_eq!(f.blocks.len(), 2);
    assert!(f.blocks.iter().all(|x| x.detours == 0 && x.active_minutes == 12));
}

#[test]
fn absorbed_detours_are_capped_at_a_share_of_the_blocks_active_minutes() {
    let p = block_params(3, 2, 25);
    // 4 + 4 active with a 2 minute detour: 2 is exactly 25% of 8, kept together
    let mut b = run("code.exe", 100, 104);
    b.extend(run("chat.exe", 104, 106));
    b.extend(run("code.exe", 106, 110));
    assert_eq!(blocks_of(&b, &p).blocks.len(), 1);
    // 3 + 3 with a 2 minute detour: 2 is 33% of 6, so the block splits
    let mut b = run("code.exe", 100, 103);
    b.extend(run("chat.exe", 103, 105));
    b.extend(run("code.exe", 105, 108));
    let f = blocks_of(&b, &p);
    assert_eq!(f.blocks.len(), 2);
    assert!(f.blocks.iter().all(|x| x.detours == 0));
}

#[test]
fn a_block_needs_the_minimum_active_minutes() {
    assert!(
        blocks_of(&run("code.exe", 100, 109), &params()).blocks.is_empty(),
        "9 minutes is under 10"
    );
    assert_eq!(blocks_of(&run("code.exe", 100, 110), &params()).blocks.len(), 1);
}

#[test]
fn a_block_with_many_internal_gaps_is_loose_and_reports_them() {
    // engaged every other minute for 10 engaged minutes: span 19, density 52%
    let mut b: Vec<BucketRow> = (0..10).map(|i| eng(100 + 2 * i)).collect();
    b.extend(calm(101, 118).into_iter().filter(|x| ((x.minute_ts - DAY0) / MIN) % 2 == 1));
    let f = blocks_of(&b, &params());
    let blk = &f.blocks[0];
    assert_eq!((blk.active_minutes, blk.span_minutes), (10, 19));
    assert!(blk.loose() && blk.density_percent() == 52);
    assert_eq!((blk.internal_gaps, blk.longest_gap_minutes), (9, 1));
}

#[test]
fn only_work_and_browser_form_blocks_other_groups_are_plain_stretches() {
    let mut b = run("code.exe", 100, 115);
    b.extend(calm(115, 117));
    b.extend(run("music.exe", 117, 135));
    b.extend(run("chat.exe", 135, 150));
    let f = blocks_of(&b, &params());
    assert!(f.blocks.iter().all(|x| x.group == "work" || x.group == "browser"));
    assert_eq!(f.blocks.len(), 1);
    let others: Vec<&str> = f.other_stretches.iter().map(|x| x.group.as_str()).collect();
    assert_eq!(others, ["media", "comms"]);
}

#[test]
fn browser_time_is_its_own_group_and_never_work() {
    let f = blocks_of(&run("chrome.exe", 100, 120), &params());
    assert_eq!(f.blocks.len(), 1);
    assert_eq!(f.blocks[0].group, "browser");
}

#[test]
fn blocks_do_not_cross_sessions() {
    let mut b = run("code.exe", 100, 112);
    b.extend(run("code.exe", 130, 142)); // 17 empty minutes between: two sessions
    let f = blocks_of(&b, &params());
    assert_eq!((f.sessions.len(), f.blocks.len()), (2, 2));
}

#[test]
fn a_block_overlapping_a_remote_session_is_marked_remote() {
    let b = run("code.exe", 100, 115);
    let remote = ev("session", "remote", at(90), at(110), json!({}));
    let f = facts(&b, &[remote]);
    assert!(f.blocks[0].remote && f.sessions[0].remote);
    assert!(!facts(&b, &[]).blocks[0].remote);
}

// ---- day facts ----

#[test]
fn first_and_last_input_are_the_first_and_last_engaged_minute_of_the_day() {
    let mut b = run("code.exe", 450, 460);
    b.extend(run("chrome.exe", 1300, 1305));
    let f = facts(&b, &[]);
    assert_eq!(f.first_input.as_ref().map(|s| (s.at - DAY0) / MIN), Some(450));
    assert_eq!(f.last_input_of_day.as_ref().map(|s| (s.at - DAY0) / MIN), Some(1304));
    assert_eq!(f.first_input.unwrap().evidence.basis, Basis::Observed);
    assert_eq!(f.engaged_minutes, 15);
    assert!(facts(&[], &[]).first_input.is_none());
}

#[test]
fn a_session_running_over_either_edge_is_marked_and_the_day_edges_stay_in_the_day() {
    // a stretch from 23:50 the day before to 00:20, and one from 23:40 to 00:10 the next day
    let mut b = run("code.exe", -10, 20);
    b.extend(run("code.exe", 24 * 60 - 20, 24 * 60 + 10));
    let f = facts(&b, &[]);
    assert_eq!(f.sessions.len(), 2);
    assert!(f.sessions[0].continues_from_previous_day && !f.sessions[0].continues_after_midnight);
    assert!(f.sessions[1].continues_after_midnight && !f.sessions[1].continues_from_previous_day);
    assert_eq!(f.first_input.as_ref().map(|s| (s.at - DAY0) / MIN), Some(0), "not minute -10");
    assert_eq!(f.last_input_of_day.as_ref().map(|s| (s.at - DAY0) / MIN), Some(24 * 60 - 1));
    assert_eq!(f.engaged_minutes, 20 + 20);
    assert_eq!(sessions_of(&f)[0].0, 0, "the session is clipped to the day");
    assert!(f.blocks.iter().any(|x| x.continues_from_previous_day) && f.blocks.iter().any(|x| x.continues_after_midnight));
}

#[test]
fn the_longest_unbroken_stretch_is_the_longest_session() {
    let mut b = run("code.exe", 100, 130);
    b.extend(run("chrome.exe", 300, 400));
    b.extend(run("code.exe", 600, 620));
    let f = facts(&b, &[]);
    let longest = f.longest.unwrap();
    assert_eq!((longest.start - DAY0) / MIN, 300);
    assert_eq!(longest.active_minutes, 100);
}

#[test]
fn input_observed_and_foreground_totals() {
    let b = vec![bk(100, "code.exe", 12), bk(101, "code.exe", 3)];
    let f = facts(&b, &[]);
    assert_eq!((f.input_ms, f.observed_ms), (15_000, 120_000));
    assert_eq!(f.foreground_ms, 24 * 60 * MIN);
}

// ---- switch rate ----

fn switch_facts(events: &[EventRow], observed_minutes: i64) -> DayFacts {
    let b = calm(0, observed_minutes);
    facts_with(&b, events, at(0), at(24 * 60), &params())
}

#[test]
fn a_b_for_one_second_a_is_no_switch() {
    let events = [
        app("code.exe", at(0), at(1)),
        app("chrome.exe", at(1), at(1) + 1_000),
        app("code.exe", at(1) + 1_000, at(2)),
    ];
    let s = switch_facts(&events, 2).switches.unwrap();
    assert_eq!((s.between_apps, s.between_groups), (0, 0));
}

#[test]
fn switches_count_exe_changes_and_group_changes_per_foreground_hour() {
    let events = [
        app("code.exe", at(0), at(15)),
        app("wt.exe", at(15), at(30)),     // app switch, same group
        app("chrome.exe", at(30), at(45)), // app and group switch
        app("code.exe", at(45), at(60)),   // app and group switch
    ];
    let s = switch_facts(&events, 60).switches.unwrap();
    assert_eq!((s.between_apps, s.between_groups), (3, 2));
    assert!((s.per_hour_apps - 3.0).abs() < 1e-9 && (s.per_hour_groups - 2.0).abs() < 1e-9);
}

#[test]
fn a_change_across_an_interruption_is_not_a_switch() {
    let events = [
        app("code.exe", at(0), at(10)),
        ev("session", "locked", at(10), at(20), json!({})),
        app("chrome.exe", at(20), at(30)),
        ev("foreground", "unknown", at(30), at(35), json!({})),
        app("code.exe", at(35), at(45)),
    ];
    let s = switch_facts(&events, 45).switches.unwrap();
    assert_eq!(s.between_apps, 0);
}

#[test]
fn a_change_across_a_hole_in_the_record_is_not_a_switch_but_flicker_is_not_a_hole() {
    // nothing recorded between 10 and 20 minutes: unknown, not a switch
    let events = [app("code.exe", at(0), at(10)), app("chrome.exe", at(20), at(30))];
    assert_eq!(switch_facts(&events, 30).switches.unwrap().between_apps, 0);
    // a one second flicker between two apps leaves a one second hole that is accounted for
    let events = [
        app("code.exe", at(0), at(10)),
        app("wt.exe", at(10), at(10) + 1_000),
        app("chrome.exe", at(10) + 1_000, at(20)),
    ];
    assert_eq!(switch_facts(&events, 20).switches.unwrap().between_apps, 1);
}

#[test]
fn the_rate_is_n_a_when_under_half_of_the_foreground_time_was_observed() {
    let events = [app("code.exe", at(0), at(30)), app("chrome.exe", at(30), at(60))];
    assert!(switch_facts(&events, 29).switches.is_none(), "29 of 60 minutes");
    assert!(switch_facts(&events, 30).switches.is_some(), "exactly half");
    assert!(switch_facts(&[], 60).switches.is_none(), "no foreground time at all");
}

// ---- coverage, partial, purge ----

#[test]
fn a_day_under_80_percent_known_is_partial_and_counts_unknown_minutes() {
    let f = facts(&run("code.exe", 0, 600), &[]);
    assert!(f.partial);
    assert_eq!(f.unknown_minutes, 24 * 60 - 600);
    // time explained by a lock is not unknown
    let lock = ev("session", "locked", at(600), at(24 * 60), json!({}));
    let f = facts(&run("code.exe", 0, 600), &[lock]);
    assert_eq!((f.unknown_minutes, f.partial), (0, false));
}

#[test]
fn buckets_without_events_are_marked_events_purged_and_give_no_facts() {
    let b = run("code.exe", 100, 130);
    let f = facts_with(&b, &[], at(0), at(1440), &params());
    assert_eq!(f.availability, Availability::EventsPurged);
    assert!(f.sessions.is_empty() && f.blocks.is_empty() && f.first_input.is_none() && f.switches.is_none());
}

#[test]
fn events_without_buckets_are_no_input_data() {
    let f = facts_with(&[], &[app("code.exe", at(0), at(60))], at(0), at(1440), &params());
    assert_eq!(f.availability, Availability::NoInputData);
    assert!(f.first_input.is_none());
}

#[test]
fn only_the_recorded_part_of_the_day_counts_towards_partial() {
    let b = run("code.exe", 0, 600);
    let ev = [app("code.exe", at(0), at(600))];
    // viewed at 10:00: everything from the first record to now was watched
    let f = facts_until(&b, &ev, at(0), at(1440), at(600), None, &params());
    assert_eq!((f.partial, f.unknown_minutes), (false, 0));
    // the same rows seen at the end of the day: 840 minutes with nothing
    let f = facts_until(&b, &ev, at(0), at(1440), at(1440), None, &params());
    assert_eq!((f.partial, f.unknown_minutes), (true, 840));
    // a day that starts recording at 09:00 is not unknown before that
    let b = run("code.exe", 540, 600);
    let ev = [app("code.exe", at(540), at(600))];
    let f = facts_until(&b, &ev, at(0), at(1440), at(600), None, &params());
    assert_eq!((f.partial, f.unknown_minutes), (false, 0));
}

#[test]
fn a_retention_cutoff_mid_day_splits_sessions_and_marks_the_day_partial() {
    // engaged 100..105, quiet 105..108, engaged 108..113: one session, until the lock that was in the gap is purged
    let mut b = run("code.exe", 100, 105);
    b.extend(calm(105, 108));
    b.extend(run("code.exe", 108, 113));
    let ev = [app("code.exe", at(0), at(1440))];
    let whole = facts_until(&b, &ev, at(0), at(1440), at(1440), None, &params());
    assert_eq!(whole.sessions.len(), 1);
    // events before 01:46 were purged: the oldest surviving one ended at minute 106
    let cut = facts_until(&b, &ev, at(0), at(1440), at(1440), Some(at(106)), &params());
    assert_eq!(cut.sessions.len(), 2, "the lost events could have been a lock in that gap");
    assert!(cut.partial, "the purged part is unknown");
    // a floor before every bucket changes nothing
    let early = facts_until(&b, &ev, at(0), at(1440), at(1440), Some(at(50)), &params());
    assert_eq!(early.sessions.len(), 1);
    // a floor after the whole day is "events purged"
    let gone = facts_until(&b, &ev, at(0), at(1440), at(1440), Some(at(2000)), &params());
    assert_eq!(gone.availability, Availability::EventsPurged);
}

// ---- determinism and properties ----

#[test]
fn the_order_of_rows_does_not_change_the_answer() {
    let mut b = run("code.exe", 100, 112);
    b.extend(run("chat.exe", 112, 114));
    b.extend(run("code.exe", 114, 125));
    b.extend(run("chrome.exe", 200, 230));
    let events = vec![
        app("code.exe", at(100), at(125)),
        app("chrome.exe", at(200), at(230)),
        ev("session", "locked", at(150), at(160), json!({})),
    ];
    let a = facts_with(&b, &events, at(0), at(1440), &params());
    let mut b2 = b.clone();
    b2.reverse();
    let mut e2 = events.clone();
    e2.reverse();
    let c = facts_with(&b2, &e2, at(0), at(1440), &params());
    assert_eq!(a, c);
}

#[test]
fn blocks_never_overlap_active_stays_within_span_and_input_within_observed() {
    let mut seed = 99u64;
    let mut rnd = move || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as u32
    };
    let exes = ["code.exe", "chrome.exe", "chat.exe", "music.exe", "wt.exe"];
    for round in 0..200 {
        let mut b = Vec::new();
        for k in 0..400 {
            if rnd() % 10 == 0 {
                continue; // unobserved
            }
            let exe = exes[(rnd() as usize / 7 + (k as usize / 20)) % exes.len()];
            let input = if rnd() % 3 == 0 { 0 } else { (rnd() % 25) as i64 };
            b.push(bk(k, exe, input));
        }
        let mut p = params();
        p.min_block_minutes = 2 + rnd() % 8;
        p.detour_minutes = 1 + rnd() % p.min_block_minutes.min(3);
        p.session_gap_minutes = 1 + rnd() % 6;
        let f = facts_with(&b, &[app("code.exe", at(0), at(1440))], at(0), at(1440), &p);
        let mut spans: Vec<(i64, i64)> = f.blocks.iter().chain(&f.other_stretches).map(|x| (x.start, x.end)).collect();
        spans.sort();
        for w in spans.windows(2) {
            assert!(w[0].1 <= w[1].0, "round {round}: blocks overlap {w:?}");
        }
        for x in f.blocks.iter().chain(&f.other_stretches) {
            assert!(i64::from(x.active_minutes) <= i64::from(x.span_minutes), "round {round}");
            assert_eq!((x.end - x.start) / MIN, i64::from(x.span_minutes));
            assert!(x.active_minutes >= p.min_block_minutes, "round {round}");
        }
        assert!(f.input_ms <= f.observed_ms);
        let mut ss: Vec<(i64, i64)> = f.sessions.iter().map(|s| (s.start, s.end)).collect();
        ss.sort();
        for w in ss.windows(2) {
            assert!(w[0].1 <= w[1].0, "round {round}: sessions overlap");
        }
    }
}

// ---- local day across DST ----

#[test]
fn a_25_hour_day_is_derived_across_the_repeated_hour_without_gluing_sessions() {
    let tz = auckland();
    let day = days_from_civil(2026, 4, 5);
    let (from, to) = tz.day_window(day);
    assert_eq!((to - from) / 3_600_000, 25);
    // engaged for 15 minutes at the first 02:30 and again at the second 02:30, an hour of UTC apart
    let first = from + (2 * 60 + 30) * MIN; // 02:30 NZDT
    let second = first + 60 * MIN; // 02:30 NZST
    let mut b = Vec::new();
    for base in [first, second] {
        for i in 0..15 {
            b.push(BucketRow {
                minute_ts: base + i * MIN,
                exe: "code.exe".into(),
                observed_ms: 60_000,
                input_ms: 20_000,
            });
        }
    }
    // the quiet hour between is observed, so only the gap length separates them
    for i in 15..60 {
        b.push(BucketRow {
            minute_ts: first + i * MIN,
            exe: "code.exe".into(),
            observed_ms: 60_000,
            input_ms: 0,
        });
    }
    let f = facts_with(&b, &[app("code.exe", from, to)], from, to, &params());
    assert_eq!(f.sessions.len(), 2, "same local clock time, an hour apart: two sessions");
    assert!(f.sessions[0].start < f.sessions[1].start);
    assert_eq!(f.blocks.len(), 2);
    // both start at the label 02:30, one at each offset
    let label = |t: i64| crate::report::fmt_clock(t, tz.offset_at(t));
    assert_eq!(label(f.sessions[0].start), label(f.sessions[1].start));
    assert_eq!(tz.offset_at(f.sessions[0].start), 13 * 60);
    assert_eq!(tz.offset_at(f.sessions[1].start), 12 * 60);
}

#[test]
fn a_23_hour_day_has_a_window_of_23_hours() {
    let tz: TzOffset = auckland();
    let (from, to) = tz.day_window(days_from_civil(2026, 9, 27));
    assert_eq!((to - from) / 3_600_000, 23);
    let f = facts_with(&[], &[app("code.exe", from, to)], from, to, &params());
    assert_eq!(f.availability, Availability::NoInputData);
}

// ---- structure: no server-facing function, neutral names ----

#[test]
fn derive_exposes_nothing_network_or_server_facing_and_uses_neutral_names() {
    let src = include_str!("derive.rs");
    for token in [
        "std::net",
        "TcpStream",
        "reqwest",
        "hyper",
        "ureq",
        "http://",
        "https://",
        "crate::runner",
        "crate::cli",
        "platform::",
    ] {
        assert!(!src.contains(token), "derive.rs must not contain {token}");
    }
    let forbidden_name = [
        "wake",
        "woke",
        "awake",
        "sleep",
        "rest",
        "tired",
        "energy",
        "capacity",
        "day_start",
        "focus_level",
    ];
    let server = ["upload", "send", "post", "push", "sync", "server", "http", "network", "socket"];
    for line in src.lines().map(str::trim_start).filter(|l| l.starts_with("pub ")) {
        let words: Vec<&str> = line
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .filter(|w| !w.is_empty() && !["pub", "fn", "struct", "enum", "const", "type", "crate", "mod", "use"].contains(w))
            .collect();
        let name = words.first().copied().unwrap_or("");
        for bad in forbidden_name.iter().chain(&server) {
            assert!(!name.contains(bad), "public item `{name}` in `{line}` contains `{bad}`");
        }
    }
}
