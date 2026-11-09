//! Facts worked out from the raw rows on demand, for `report`: input stretches, input blocks, the switch
//! rate, and the first and last input of a day. Nothing here is stored: editing `categories.toml` or a
//! number in `[derive]` corrects history the next time a report runs, and no derived state needs recovery.
//!
//! The rules (units are minutes unless said):
//! * an *engaged* minute has at least `engaged_input_seconds` of input; an *observed* minute has at least
//!   30 s of poll coverage;
//! * a *gap* is the number of non-engaged minutes between two engaged ones; a *session* joins engaged minutes
//!   whose gaps are at most `session_gap_minutes` and hold no interruption and no unobserved minute;
//! * an *input block* is a run in one group (`work` or `browser` only) of at least `min_block_minutes`
//!   engaged minutes; a short visit to another group is absorbed into it, within a share cap.
//!
//! Naming is plain on purpose: these are facts about input, not about a person.

use std::collections::BTreeMap;

use crate::config::Derive;
use crate::model::Ms;
use crate::store::{BucketRow, EventRow};

const MINUTE_MS: i64 = 60_000;
/// A minute with at least this much poll coverage counts as observed.
const OBSERVED_MINUTE_MS: i64 = 30_000;
/// Foreground intervals shorter than this are flicker and do not count towards switches.
const FLICKER_MS: i64 = 3_000;
/// A stretch of this length with no foreground row at all is a hole, not a continuation.
const HOLE_MS: i64 = 2_000;
/// Below this share of the foreground time observed, the switch rate is not printed.
const MIN_SWITCH_COVERAGE_PERCENT: i64 = 50;
/// A day known for less than this share of its minutes is partial.
const MIN_KNOWN_PERCENT: i64 = 80;
/// A block denser than this is not "loose".
const LOOSE_BELOW_PERCENT: u32 = 60;
/// Only these groups form input blocks; a browser's purpose is unknowable from its exe, so it stays apart from work.
pub const BLOCK_GROUPS: &[&str] = &["work", "browser"];

/// The numbers the rules use, from `[derive]` in `config.toml`.
#[derive(Debug, Clone, PartialEq)]
pub struct Params {
    pub session_gap_minutes: u32,
    pub min_block_minutes: u32,
    pub detour_minutes: u32,
    pub detour_share_percent: u32,
    pub engaged_input_seconds: u32,
}

impl From<&Derive> for Params {
    fn from(d: &Derive) -> Self {
        Self {
            session_gap_minutes: d.session_gap_minutes,
            min_block_minutes: d.min_block_minutes,
            detour_minutes: d.detour_minutes,
            detour_share_percent: d.detour_share_percent,
            engaged_input_seconds: d.engaged_input_seconds,
        }
    }
}

impl Params {
    /// How far beyond the day to load rows, so a session running over midnight is recognised as such.
    pub fn lookaround_ms(&self) -> i64 {
        (i64::from(self.session_gap_minutes) + 1) * MINUTE_MS
    }
}

pub struct DeriveInput<'a> {
    /// The day, `[from, to)` in UTC. Rows from `Params::lookaround_ms` either side should be supplied.
    pub from: Ms,
    pub to: Ms,
    pub events: &'a [EventRow],
    pub buckets: &'a [BucketRow],
    /// exe -> group.
    pub group_of: &'a dyn Fn(&str) -> String,
    pub params: &'a Params,
    /// Where intervals still open are cut off; also the end of what has been recorded so far.
    pub open_until: Ms,
    /// The end of the oldest event still stored. Retention may have removed older events (locks, suspends)
    /// that the input rows before this instant must be read against.
    pub events_floor: Option<Ms>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Basis {
    /// Counted straight from rows (first and last input, totals).
    Observed,
    /// A label or a grouping on top of observed rows (group, block membership).
    Inferred,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Evidence {
    /// The first and last minute (UTC ms; the end is exclusive) the fact rests on.
    pub first_ms: Ms,
    pub last_ms: Ms,
    pub basis: Basis,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stamp {
    pub at: Ms,
    pub evidence: Evidence,
}

/// A run of engaged minutes joined by the gap rule.
#[derive(Debug, Clone, PartialEq)]
pub struct InputStretch {
    pub start: Ms,
    pub end: Ms,
    pub active_minutes: u32,
    pub continues_from_previous_day: bool,
    pub continues_after_midnight: bool,
    pub remote: bool,
    pub evidence: Evidence,
}

/// A run in one group within a session, with short visits elsewhere absorbed.
#[derive(Debug, Clone, PartialEq)]
pub struct InputBlock {
    pub group: String,
    pub start: Ms,
    pub end: Ms,
    pub span_minutes: u32,
    pub active_minutes: u32,
    pub detours: u32,
    pub detour_minutes: u32,
    pub internal_gaps: u32,
    pub longest_gap_minutes: u32,
    pub remote: bool,
    pub continues_from_previous_day: bool,
    pub continues_after_midnight: bool,
    pub evidence: Evidence,
}

impl InputBlock {
    /// Active minutes as a share of the span, rounded down.
    pub fn density_percent(&self) -> u32 {
        self.active_minutes * 100 / self.span_minutes.max(1)
    }

    pub fn loose(&self) -> bool {
        self.density_percent() < LOOSE_BELOW_PERCENT
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Switches {
    pub between_apps: u32,
    pub between_groups: u32,
    pub per_hour_apps: f64,
    pub per_hour_groups: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    Ok,
    /// The database has no input rows for the day (older agent, or the collector was off).
    NoInputData,
    /// Input rows exist but the events they must be read against are gone: no facts rather than wrong ones.
    EventsPurged,
}

/// Facts about input on one local day. Never a wake, sleep or presence claim: a first input says when input
/// began, not when anyone arrived.
#[derive(Debug, Clone, PartialEq)]
pub struct DayFacts {
    pub availability: Availability,
    pub first_input: Option<Stamp>,
    pub last_input_of_day: Option<Stamp>,
    pub engaged_minutes: u32,
    pub input_ms: i64,
    pub observed_ms: i64,
    pub foreground_ms: i64,
    /// Observed time as a share of foreground time, capped at 100; `None` with no foreground time.
    pub coverage_percent: Option<u32>,
    pub sessions: Vec<InputStretch>,
    pub longest: Option<InputStretch>,
    pub blocks: Vec<InputBlock>,
    /// Runs in the other groups (media, comms, play, other), printed without block wording.
    pub other_stretches: Vec<InputBlock>,
    /// `None` is "n/a": too little of the foreground time was observed.
    pub switches: Option<Switches>,
    pub unknown_minutes: u32,
    pub partial: bool,
}

impl DayFacts {
    fn empty(availability: Availability) -> Self {
        Self {
            availability,
            first_input: None,
            last_input_of_day: None,
            engaged_minutes: 0,
            input_ms: 0,
            observed_ms: 0,
            foreground_ms: 0,
            coverage_percent: None,
            sessions: Vec::new(),
            longest: None,
            blocks: Vec::new(),
            other_stretches: Vec::new(),
            switches: None,
            unknown_minutes: 0,
            partial: false,
        }
    }
}

type Span = (Ms, Ms);

#[derive(Default)]
struct MinuteAgg {
    observed: i64,
    input: i64,
    by_group: BTreeMap<String, i64>,
}

fn span_of(e: &EventRow, open_until: Ms) -> Span {
    (e.ts_start, e.ts_end.unwrap_or(open_until.max(e.ts_start)))
}

/// Does any span overlap `[lo, hi)`? An instant counts where it falls.
fn hits(spans: &[Span], lo: Ms, hi: Ms) -> bool {
    spans.iter().any(|&(s, e)| s < hi && e.max(s + 1) > lo)
}

fn union(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort();
    let mut out: Vec<Span> = Vec::new();
    for (s, e) in spans {
        match out.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}

fn overlap_len(spans: &[Span], lo: Ms, hi: Ms) -> i64 {
    spans.iter().map(|&(s, e)| (e.min(hi) - s.max(lo)).max(0)).sum()
}

fn is_interruption(source: &str, kind: &str) -> bool {
    matches!(
        (source, kind),
        ("session", "locked")
            | ("power", "suspended")
            | ("agent", "paused")
            | ("agent", "unknown")
            | ("agent", "clock_jump")
            | ("foreground", "suppressed")
    )
}

/// Time that is accounted for although nobody was polling: a lock, a suspend, a pause, a game.
fn is_explained(source: &str, kind: &str) -> bool {
    matches!(
        (source, kind),
        ("session", "locked") | ("power", "suspended") | ("agent", "paused") | ("foreground", "suppressed")
    )
}

struct Run {
    group: String,
    from: usize,
    to: usize,
}

impl Run {
    fn len(&self) -> u32 {
        (self.to - self.from) as u32
    }
}

pub fn derive(input: &DeriveInput) -> DayFacts {
    let p = input.params;
    let in_day = |ts: Ms| ts >= input.from && ts < input.to;
    if !input.buckets.iter().any(|b| in_day(b.minute_ts)) {
        return DayFacts::empty(Availability::NoInputData);
    }
    let spans: Vec<(Span, &EventRow)> = input.events.iter().map(|e| (span_of(e, input.open_until), e)).collect();
    if !spans.iter().any(|((s, e), _)| *s < input.to && *e >= input.from) || input.events_floor.is_some_and(|f| f >= input.to) {
        return DayFacts::empty(Availability::EventsPurged);
    }
    let mut facts = DayFacts::empty(Availability::Ok);

    // Per-minute aggregates over everything supplied (the day plus the lookaround).
    let mut minutes: BTreeMap<i64, MinuteAgg> = BTreeMap::new();
    for b in input.buckets {
        let m = minutes.entry(b.minute_ts.div_euclid(MINUTE_MS)).or_default();
        m.observed += b.observed_ms;
        m.input += b.input_ms;
        *m.by_group.entry((input.group_of)(&b.exe)).or_default() += b.input_ms;
    }
    let wm_from = input.from.div_euclid(MINUTE_MS);
    let wm_to = (input.to + MINUTE_MS - 1).div_euclid(MINUTE_MS);

    let mut interruptions: Vec<Span> = spans
        .iter()
        .filter(|(_, e)| is_interruption(&e.source, &e.kind))
        .map(|(s, _)| *s)
        .collect();
    if let Some(floor) = input.events_floor {
        // Retention removed the events before this; a lock or suspend among them is unknowable, so nothing
        // may be joined across that region.
        interruptions.push((i64::MIN / 2, floor));
    }
    let explained = union(
        spans
            .iter()
            .filter(|(_, e)| is_explained(&e.source, &e.kind))
            .map(|(s, _)| *s)
            .collect(),
    );
    let remote: Vec<Span> = spans
        .iter()
        .filter(|(_, e)| e.source == "session" && e.kind == "remote")
        .map(|(s, _)| *s)
        .collect();

    for b in input.buckets.iter().filter(|b| in_day(b.minute_ts)) {
        facts.input_ms += b.input_ms;
        facts.observed_ms += b.observed_ms;
    }

    // Sessions.
    let engaged: Vec<i64> = minutes
        .iter()
        .filter(|(_, m)| m.input >= i64::from(p.engaged_input_seconds) * 1000)
        .map(|(k, _)| *k)
        .collect();
    let observed = |k: i64| minutes.get(&k).is_some_and(|m| m.observed >= OBSERVED_MINUTE_MS);
    let joins = |prev: i64, next: i64| -> bool {
        let empty = next - prev - 1;
        if empty == 0 {
            return true;
        }
        empty <= i64::from(p.session_gap_minutes)
            && (prev + 1..next).all(&observed)
            && !hits(&interruptions, (prev + 1) * MINUTE_MS, next * MINUTE_MS)
    };
    let mut sessions: Vec<Vec<i64>> = Vec::new();
    for &e in &engaged {
        match sessions.last_mut() {
            Some(cur) if joins(*cur.last().unwrap_or(&e), e) => cur.push(e),
            _ => sessions.push(vec![e]),
        }
    }

    let group_of_minute = |k: i64| -> String {
        let mut best: Option<(&String, i64)> = None;
        if let Some(m) = minutes.get(&k) {
            for (g, v) in &m.by_group {
                if best.is_none_or(|(_, bv)| *v > bv) {
                    best = Some((g, *v));
                }
            }
        }
        best.map(|(g, _)| g.clone()).unwrap_or_else(|| "other".into())
    };

    for s in &sessions {
        let day_minutes: Vec<i64> = s.iter().copied().filter(|&k| k >= wm_from && k < wm_to).collect();
        let (Some(&first), Some(&last)) = (day_minutes.first(), day_minutes.last()) else {
            continue;
        };
        let carried_in = s[0] < wm_from;
        let carried_out = s[s.len() - 1] >= wm_to;
        facts.engaged_minutes += day_minutes.len() as u32;
        let (start, end) = (first * MINUTE_MS, (last + 1) * MINUTE_MS);
        facts.sessions.push(InputStretch {
            start,
            end,
            active_minutes: day_minutes.len() as u32,
            continues_from_previous_day: carried_in,
            continues_after_midnight: carried_out,
            remote: hits(&remote, start, end),
            evidence: Evidence {
                first_ms: start,
                last_ms: end,
                basis: Basis::Inferred,
            },
        });
        let entries: Vec<(i64, String)> = day_minutes.iter().map(|&k| (k, group_of_minute(k))).collect();
        for blk in blocks_in(&entries, p) {
            let (bs, be) = (entries[blk.first].0 * MINUTE_MS, (entries[blk.last_to - 1].0 + 1) * MINUTE_MS);
            let mut gaps = 0;
            let mut longest = 0;
            for w in entries[blk.first..blk.last_to].windows(2) {
                let gap = (w[1].0 - w[0].0 - 1) as u32;
                if gap > 0 {
                    gaps += 1;
                    longest = longest.max(gap);
                }
            }
            let block = InputBlock {
                group: blk.group.clone(),
                start: bs,
                end: be,
                span_minutes: ((be - bs) / MINUTE_MS) as u32,
                active_minutes: blk.active,
                detours: blk.detours,
                detour_minutes: blk.detour_minutes,
                internal_gaps: gaps,
                longest_gap_minutes: longest,
                remote: hits(&remote, bs, be),
                continues_from_previous_day: carried_in && blk.first == 0,
                continues_after_midnight: carried_out && blk.last_to == entries.len(),
                evidence: Evidence {
                    first_ms: bs,
                    last_ms: be,
                    basis: Basis::Inferred,
                },
            };
            if BLOCK_GROUPS.contains(&block.group.as_str()) {
                facts.blocks.push(block);
            } else {
                facts.other_stretches.push(block);
            }
        }
    }
    facts.blocks.sort_by_key(|b| b.start);
    facts.other_stretches.sort_by_key(|b| b.start);
    facts.longest = facts
        .sessions
        .iter()
        .fold(None::<&InputStretch>, |best, s| match best {
            Some(b) if (b.end - b.start) >= (s.end - s.start) => Some(b),
            _ => Some(s),
        })
        .cloned();

    // First and last engaged minute of the day.
    let day_engaged = || engaged.iter().copied().filter(|&k| k >= wm_from && k < wm_to);
    let stamp = |k: i64| Stamp {
        at: k * MINUTE_MS,
        evidence: Evidence {
            first_ms: k * MINUTE_MS,
            last_ms: (k + 1) * MINUTE_MS,
            basis: Basis::Observed,
        },
    };
    facts.first_input = day_engaged().next().map(stamp);
    facts.last_input_of_day = day_engaged().next_back().map(stamp);

    // Foreground time and switches.
    let mut apps: Vec<(String, Ms, Ms)> = Vec::new();
    let mut breaks: Vec<Span> = interruptions.clone();
    for ((s, e), ev) in &spans {
        if ev.source == "foreground" && ev.kind == "unknown" {
            // A window nobody could read: a change across it is not known to be a switch.
            breaks.push((*s, *e));
        }
        if ev.source == "foreground" && ev.kind == "app" {
            let (cs, ce) = ((*s).max(input.from), (*e).min(input.to));
            if ce > cs {
                apps.push((ev.attrs["exe"].as_str().unwrap_or("").to_string(), cs, ce));
            }
        }
    }
    apps.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    facts.foreground_ms = apps.iter().map(|a| a.2 - a.1).sum();
    // Every foreground interval, flicker included: time none of them covers is time nothing recorded.
    let covered = union(apps.iter().map(|a| (a.1, a.2)).collect());
    if facts.foreground_ms > 0 {
        facts.coverage_percent = Some((facts.observed_ms * 100 / facts.foreground_ms).min(100) as u32);
    }
    // Drop flicker first, then merge same-exe neighbours (A, B for 1 s, A is no switch).
    let mut merged: Vec<(String, Ms, Ms)> = Vec::new();
    for (exe, s, e) in apps.into_iter().filter(|a| a.2 - a.1 >= FLICKER_MS) {
        match merged.last_mut() {
            Some(last) if last.0 == exe => last.2 = last.2.max(e),
            _ => merged.push((exe, s, e)),
        }
    }
    if facts.foreground_ms > 0 && facts.observed_ms * 100 >= MIN_SWITCH_COVERAGE_PERCENT * facts.foreground_ms {
        let (mut apps_n, mut groups_n) = (0u32, 0u32);
        for w in merged.windows(2) {
            // A change across a hole in the record (more than flicker long) is not known to be a switch.
            let hole = (w[1].1 - w[0].2) - overlap_len(&covered, w[0].2, w[1].1);
            if hits(&breaks, w[0].2, w[1].1) || hole > HOLE_MS {
                continue;
            }
            apps_n += 1;
            if (input.group_of)(&w[0].0) != (input.group_of)(&w[1].0) {
                groups_n += 1;
            }
        }
        let hours = facts.foreground_ms as f64 / 3_600_000.0;
        facts.switches = Some(Switches {
            between_apps: apps_n,
            between_groups: groups_n,
            per_hour_apps: f64::from(apps_n) / hours,
            per_hour_groups: f64::from(groups_n) / hours,
        });
    }

    // How much of the recorded part of the day is known: watched, or accounted for by a lock, suspend, pause
    // or game. The span runs from the first record of the day to now (or the end of the day), so minutes that
    // have not happened yet, or came before the agent first recorded, are not "unknown".
    let first_recorded = input
        .buckets
        .iter()
        .map(|b| b.minute_ts)
        .chain(spans.iter().map(|((s, _), _)| *s))
        .filter(|&t| t < input.to)
        .min()
        .unwrap_or(input.from)
        .max(input.from);
    let rec_from = first_recorded.div_euclid(MINUTE_MS);
    let rec_to = ((input.open_until.min(input.to) + MINUTE_MS - 1).div_euclid(MINUTE_MS)).max(rec_from);
    let mut unknown = 0u32;
    for k in rec_from..rec_to {
        let watched = minutes.get(&k).map_or(0, |m| m.observed);
        let accounted = overlap_len(&explained, k * MINUTE_MS, (k + 1) * MINUTE_MS);
        let events_lost = input.events_floor.is_some_and(|f| (k + 1) * MINUTE_MS <= f);
        if events_lost || watched + accounted < OBSERVED_MINUTE_MS {
            unknown += 1;
        }
    }
    let total = rec_to - rec_from;
    facts.unknown_minutes = unknown;
    facts.partial = total > 0 && (total - i64::from(unknown)) * 100 < MIN_KNOWN_PERCENT * total;
    facts
}

struct RawBlock {
    group: String,
    first: usize,
    last_to: usize,
    active: u32,
    detours: u32,
    detour_minutes: u32,
}

/// Blocks within one session's engaged minutes (`entries`: minute, group).
fn blocks_in(entries: &[(i64, String)], p: &Params) -> Vec<RawBlock> {
    let mut runs: Vec<Run> = Vec::new();
    for (i, (_, g)) in entries.iter().enumerate() {
        match runs.last_mut() {
            Some(r) if &r.group == g => r.to = i + 1,
            _ => runs.push(Run {
                group: g.clone(),
                from: i,
                to: i + 1,
            }),
        }
    }
    let mut consumed = vec![false; runs.len()];
    let mut out = Vec::new();
    for i in 0..runs.len() {
        if consumed[i] {
            continue;
        }
        consumed[i] = true;
        let g = runs[i].group.clone();
        let (first, mut last_to) = (runs[i].from, runs[i].to);
        let mut active = runs[i].len();
        let (mut detours, mut detour_minutes) = (0u32, 0u32);
        let mut j = i + 1;
        loop {
            // The visit elsewhere: every run up to the next one in this group.
            let mut k = j;
            let mut away = 0;
            while k < runs.len() && runs[k].group != g {
                away += runs[k].len();
                k += 1;
            }
            if k >= runs.len() || away == 0 || away > p.detour_minutes {
                break;
            }
            let new_active = active + runs[k].len();
            let new_detour = detour_minutes + away;
            if new_detour * 100 > p.detour_share_percent * new_active {
                break;
            }
            for c in consumed.iter_mut().take(k + 1).skip(j) {
                *c = true;
            }
            active = new_active;
            detour_minutes = new_detour;
            detours += 1;
            last_to = runs[k].to;
            j = k + 1;
        }
        if active >= p.min_block_minutes {
            out.push(RawBlock {
                group: g,
                first,
                last_to,
                active,
                detours,
                detour_minutes,
            });
        }
    }
    out
}
