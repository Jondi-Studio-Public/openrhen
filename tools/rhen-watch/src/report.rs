//! `rhen-watch report`: what was captured on one day, as plain text.

use std::collections::BTreeMap;
use std::fmt::Write;

use crate::categories::{self, Catalogue};
use crate::derive::{self, Availability, DayFacts, DeriveInput, InputBlock, Params};
use crate::model::{Ms, SRC_AGENT, SRC_FOREGROUND, SRC_IDLE, SRC_POWER, SRC_SESSION};
use crate::store::{BucketRow, EventRow, MetricRow, Store};
use crate::tz::TzOffset;

type Span = (Ms, Ms);

fn clip(start: Ms, end: Ms, from: Ms, to: Ms) -> Option<Span> {
    let (s, e) = (start.max(from), end.min(to));
    (e > s).then_some((s, e))
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

fn overlap(span: Span, merged: &[Span]) -> Ms {
    merged.iter().map(|&(s, e)| (span.1.min(e) - span.0.max(s)).max(0)).sum()
}

pub fn fmt_duration(ms: Ms) -> String {
    let total = (ms.max(0) + 30_000) / 60_000;
    if total >= 60 {
        format!("{}h {:02}m", total / 60, total % 60)
    } else {
        format!("{total}m")
    }
}

pub fn fmt_clock(ts: Ms, offset_min: i32) -> String {
    let secs = (ts / 1000) + i64::from(offset_min) * 60;
    let day_secs = secs.rem_euclid(86_400);
    format!("{:02}:{:02}", day_secs / 3600, (day_secs % 3600) / 60)
}

pub fn fmt_offset(offset_min: i32) -> String {
    let sign = if offset_min < 0 { '-' } else { '+' };
    let a = offset_min.abs();
    format!("UTC{sign}{:02}:{:02}", a / 60, a % 60)
}

#[derive(Default)]
struct AppTotal {
    category: String,
    total: Ms,
    idle: Ms,
}

pub struct ReportInput<'a> {
    pub label: &'a str,
    pub from: Ms,
    pub to: Ms,
    /// Where open intervals are cut off: the last heartbeat, or now.
    pub open_until: Ms,
    pub tz: TzOffset,
    /// The current category map: categories are re-resolved from it, so labelling an exe relabels history here.
    pub catalogue: &'a Catalogue,
    pub params: &'a Params,
    /// `collectors.idle`; with it off there is no input data and the report says that rather than print zeros.
    pub idle_collector: bool,
}

/// Everything `render` reads, loaded once.
pub struct Rows<'a> {
    /// Events overlapping the day.
    pub day_events: &'a [EventRow],
    /// Events overlapping the day plus the lookaround, for derived facts that run over midnight.
    pub all_events: &'a [EventRow],
    pub buckets: &'a [BucketRow],
    pub has_buckets_table: bool,
    /// End of the oldest stored event (see `DeriveInput::events_floor`).
    pub events_floor: Option<Ms>,
    pub metrics: &'a [MetricRow],
    pub db_bytes: i64,
}

pub fn build(store: &Store, input: &ReportInput) -> Result<String, String> {
    let look = input.params.lookaround_ms();
    let (lo, hi) = (input.from - look, input.to + look);
    let mut all = store.events_between(lo, hi).map_err(|e| e.to_string())?;
    all.extend(store.open_rows().into_iter().filter(|e| e.ts_start < hi));
    all.sort_by_key(|e| e.ts_start);
    let day: Vec<EventRow> = all
        .iter()
        .filter(|e| e.ts_start < input.to && e.ts_end.is_none_or(|end| end >= input.from))
        .cloned()
        .collect();
    let buckets = store.buckets_between(lo, hi).map_err(|e| e.to_string())?;
    let metrics = store.metrics_between(input.from, input.to).map_err(|e| e.to_string())?;
    Ok(render(
        &Rows {
            day_events: &day,
            all_events: &all,
            buckets: &buckets,
            has_buckets_table: store.has_input_buckets(),
            events_floor: store.earliest_event_end().map_err(|e| e.to_string())?,
            metrics: &metrics,
            db_bytes: store.db_bytes(),
        },
        input,
    ))
}

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// Kinds written as instants. Everything else is an interval, which can also end up with no length.
fn is_instant_kind(source: &str, kind: &str) -> bool {
    matches!(
        (source, kind),
        (SRC_SESSION, "logon" | "logoff")
            | (SRC_POWER, "ac" | "battery")
            | (SRC_AGENT, "start" | "stop" | "degraded" | "dropped" | "clock_jump")
    )
}

fn clock(ts: Ms, tz: &TzOffset) -> String {
    fmt_clock(ts, tz.offset_at(ts))
}

/// The offset of the day, or both when clocks changed during it.
fn offset_label(input: &ReportInput) -> String {
    let (start, end) = (input.tz.offset_at(input.from), input.tz.offset_at(input.to - 1));
    if start == end {
        fmt_offset(start)
    } else {
        format!("{} then {}", fmt_offset(start), fmt_offset(end))
    }
}

fn plural(n: u32, one: &str) -> String {
    if n == 1 { format!("{n} {one}") } else { format!("{n} {one}s") }
}

fn block_text(b: &InputBlock, tz: &TzOffset) -> String {
    let mut out = format!("{}-{} {}m active", clock(b.start, tz), clock(b.end, tz), b.active_minutes);
    if b.detours > 0 {
        out.push_str(&format!(", {} ({}m)", plural(b.detours, "detour"), b.detour_minutes));
    }
    if b.loose() {
        out.push_str(", loose");
    }
    if b.remote {
        out.push_str(", remote");
    }
    if b.continues_from_previous_day {
        out.push_str(", continues from the day before");
    }
    if b.continues_after_midnight {
        out.push_str(", continues after midnight");
    }
    out
}

/// "Your day at the PC": facts derived from the rows, labelled as such, in neutral words. No sentence here
/// claims anything about a person, only about input.
fn day_section(facts: &DayFacts, rows: &Rows, input: &ReportInput, uncategorised: &[(String, Ms)]) -> String {
    let tz = &input.tz;
    let mut out = String::new();
    let weekday = WEEKDAYS[(tz.day_of(input.from) + 4).rem_euclid(7) as usize];
    let offset = offset_label(input);
    let _ = writeln!(
        out,
        "Your day at the PC, {weekday} {} ({offset})   [derived from the rows below; not stored]",
        input.label
    );
    match facts.availability {
        Availability::NoInputData => {
            let paused = paused_ms(rows, input);
            // Paused explains the day only when it covers about all of the recorded part of it.
            let first = rows.day_events.iter().map(|e| e.ts_start).filter(|&t| t >= input.from).min();
            let recorded = first.map_or(0, |f| input.open_until.min(input.to) - f);
            let all_paused = paused > 0 && paused * 10 >= recorded * 9;
            let also = if paused > 0 && !all_paused {
                format!(" (also paused {})", fmt_duration(paused))
            } else {
                String::new()
            };
            let why = if all_paused {
                format!("agent paused for {}", fmt_duration(paused))
            } else if !rows.has_buckets_table {
                "agent older than this report".to_string()
            } else if !input.idle_collector {
                "idle collector off".to_string()
            } else {
                // The table exists and the collector is on: nothing was tallied that day.
                let _ = writeln!(out, "  no input data for this day{also}");
                return out;
            };
            let _ = writeln!(out, "  no input data ({why}){also}");
            return out;
        }
        Availability::EventsPurged => {
            let _ = writeln!(
                out,
                "  partial: events purged; no facts for this day (the rows they are read against are gone)"
            );
            return out;
        }
        Availability::Ok => {}
    }
    if facts.partial {
        let _ = writeln!(out, "  (partial: {} min unknown)", facts.unknown_minutes);
    }
    match (&facts.first_input, &facts.last_input_of_day) {
        (Some(first), Some(last)) => {
            let _ = writeln!(
                out,
                "  First input {}, last input {}   (first and last input of the day; not a claim about presence)",
                clock(first.at, tz),
                clock(last.at, tz)
            );
        }
        _ => {
            let _ = writeln!(out, "  No minute of the day had enough input to count");
        }
    }
    let coverage = facts.coverage_percent.map_or("n/a".to_string(), |c| format!("{c}%"));
    let _ = writeln!(
        out,
        "  Input: {} in 5 s slots, {} in front, observed coverage {coverage}",
        fmt_duration(facts.input_ms),
        fmt_duration(facts.foreground_ms)
    );
    if let Some(l) = &facts.longest {
        let _ = writeln!(
            out,
            "  Longest unbroken stretch: {}-{} ({}; gaps of up to {} min count as unbroken){}{}",
            clock(l.start, tz),
            clock(l.end, tz),
            fmt_duration(l.end - l.start),
            input.params.session_gap_minutes,
            if l.continues_from_previous_day {
                ", continues from the day before"
            } else {
                ""
            },
            if l.continues_after_midnight {
                ", continues after midnight"
            } else {
                ""
            },
        );
    }
    let mut by_group: BTreeMap<&str, Vec<&InputBlock>> = BTreeMap::new();
    for b in &facts.blocks {
        by_group.entry(b.group.as_str()).or_default().push(b);
    }
    if by_group.is_empty() {
        let _ = writeln!(out, "  Input blocks: none of at least {} minutes", input.params.min_block_minutes);
    }
    for (group, blocks) in by_group {
        let list: Vec<String> = blocks.iter().map(|b| block_text(b, tz)).collect();
        let _ = writeln!(out, "  Input blocks ({group}): {}", list.join("; "));
    }
    if !facts.other_stretches.is_empty() {
        let list: Vec<String> = facts
            .other_stretches
            .iter()
            .map(|b| format!("{} {}", b.group, block_text(b, tz)))
            .collect();
        let _ = writeln!(out, "  Input stretches by group: {}", list.join("; "));
    }
    match &facts.switches {
        Some(s) => {
            let rate = |v: f64| if v >= 10.0 { format!("{v:.0}") } else { format!("{v:.1}") };
            let _ = writeln!(
                out,
                "  Switches: {} per observed foreground hour between apps, {} between groups",
                rate(s.per_hour_apps),
                rate(s.per_hour_groups)
            );
        }
        None => {
            let _ = writeln!(out, "  Switches: n/a (under half of the foreground time was observed)");
        }
    }
    if !uncategorised.is_empty() {
        let _ = writeln!(
            out,
            "  Not categorised yet (add to [exe] in categories.toml, or run: rhen-watch categories set EXE CATEGORY):"
        );
        for (exe, ms) in uncategorised {
            let _ = writeln!(out, "    {exe}  {}   {}", fmt_duration(*ms), categories::paste_line(exe));
        }
    }
    for category in input.catalogue.groupless() {
        let _ = writeln!(
            out,
            "  Category \"{category}\" has no group, so it counts as other (add it under [group] in categories.toml)"
        );
    }
    if facts.blocks.iter().any(|b| b.group == "browser") {
        let _ = writeln!(
            out,
            "  Browser time is kept apart from work: what a browser is used for cannot be told from its exe."
        );
    }
    let _ = writeln!(out, "  Input includes synthetic input (remote tools, jigglers, scheduled tasks).");
    out
}

/// Time in the day the agent was paused from the tray.
fn paused_ms(rows: &Rows, input: &ReportInput) -> Ms {
    rows.day_events
        .iter()
        .filter(|e| e.source == SRC_AGENT && e.kind == "paused")
        .filter_map(|e| {
            clip(
                e.ts_start,
                e.ts_end.unwrap_or(input.open_until.max(e.ts_start)),
                input.from,
                input.to,
            )
        })
        .map(|s| s.1 - s.0)
        .sum()
}

pub fn render(rows: &Rows, input: &ReportInput) -> String {
    let events = rows.day_events;
    let metrics = rows.metrics;
    let db_bytes = rows.db_bytes;
    let span = |e: &EventRow| {
        clip(
            e.ts_start,
            e.ts_end.unwrap_or(input.open_until.max(e.ts_start)),
            input.from,
            input.to,
        )
    };

    let idle_spans = union(events.iter().filter(|e| e.source == SRC_IDLE).filter_map(span).collect());
    let mut apps: BTreeMap<String, AppTotal> = BTreeMap::new();
    let (mut suppressed, mut unreadable, mut locked, mut asleep, mut display_off, mut remote, mut unknown) = (0, 0, 0, 0, 0, 0, 0);
    let (mut paused, mut off) = (0, 0);
    let mut gaps: Vec<(Span, String)> = Vec::new();
    let mut instants: BTreeMap<String, usize> = BTreeMap::new();
    let mut clock_jumps = 0;
    for e in events {
        // An instant has no length, so it cannot be clipped: it counts when it falls inside the day.
        if e.ts_end == Some(e.ts_start) {
            // Only kinds that are instants by nature: an interval closed at its own start also has no length.
            if is_instant_kind(&e.source, &e.kind) && (input.from..input.to).contains(&e.ts_start) {
                if (e.source.as_str(), e.kind.as_str()) == (SRC_AGENT, "clock_jump") {
                    clock_jumps += 1;
                } else {
                    *instants.entry(format!("{}/{}", e.source, e.kind)).or_default() += 1;
                }
            }
            continue;
        }
        let Some(s) = span(e) else { continue };
        let len = s.1 - s.0;
        match (e.source.as_str(), e.kind.as_str()) {
            (SRC_FOREGROUND, "app") => {
                let exe = e.attrs["exe"].as_str().unwrap_or("?").to_string();
                let exe_key = exe.clone();
                let entry = apps.entry(exe).or_default();
                // The category is read from the current map, not the one stored when the row was written.
                entry.category = input.catalogue.lookup(&exe_key).unwrap_or("other").to_string();
                entry.total += len;
                entry.idle += overlap(s, &idle_spans);
            }
            (SRC_FOREGROUND, "suppressed") => suppressed += len,
            (SRC_FOREGROUND, "unknown") => unreadable += len,
            (SRC_SESSION, "locked") => locked += len,
            (SRC_SESSION, "remote") => remote += len,
            (SRC_POWER, "suspended") => asleep += len,
            (SRC_POWER, "display_off") => display_off += len,
            (SRC_AGENT, "unknown") => {
                unknown += len;
                gaps.push((s, e.attrs["reason"].as_str().unwrap_or("unknown").to_string()));
            }
            (SRC_AGENT, "paused") => paused += len,
            (SRC_AGENT, "off") => off += len,
            _ => {}
        }
    }

    let fg_total: Ms = apps.values().map(|a| a.total).sum();
    let idle_in_fg: Ms = apps.values().map(|a| a.idle).sum();
    let mut categories: BTreeMap<&str, (Ms, Ms)> = BTreeMap::new();
    for a in apps.values() {
        let c = categories.entry(a.category.as_str()).or_default();
        c.0 += a.total;
        c.1 += a.idle;
    }

    let group_of = |exe: &str| -> String {
        if exe.is_empty() {
            "other".to_string()
        } else {
            input.catalogue.group_of_exe(exe).to_string()
        }
    };
    let facts = derive::derive(&DeriveInput {
        from: input.from,
        to: input.to,
        events: rows.all_events,
        buckets: rows.buckets,
        group_of: &group_of,
        params: input.params,
        open_until: input.open_until,
        events_floor: rows.events_floor,
    });
    let totals: Vec<(String, Ms)> = apps.iter().map(|(exe, a)| (exe.clone(), a.total)).collect();
    let uncategorised = categories::uncategorised(&totals, input.catalogue, 15);
    let mut out = day_section(&facts, rows, input, &uncategorised);
    out.push('\n');
    let _ = writeln!(out, "Activity for {} ({})", input.label, offset_label(input));
    if events.is_empty() {
        let _ = writeln!(
            out,
            "\nNothing was captured on this day. The agent was not running, or it had nothing to record."
        );
    }
    let _ = writeln!(
        out,
        "\nIn front of an app: {}  (of which idle: {})",
        fmt_duration(fg_total),
        fmt_duration(idle_in_fg)
    );
    let _ = writeln!(out, "In front and not in an idle interval: {}", fmt_duration(fg_total - idle_in_fg));
    for (label, ms) in [
        ("Screen locked", locked),
        ("Suspended", asleep),
        ("Display off", display_off),
        ("Remote session", remote),
        ("Suppressed (game in front)", suppressed),
        ("Window unreadable", unreadable),
        ("Paused (from the tray)", paused),
        ("Agent off", off),
        ("Unknown (agent not running or machine stalled)", unknown),
    ] {
        if ms > 0 {
            let _ = writeln!(out, "{label}: {}", fmt_duration(ms));
        }
    }
    if !categories.is_empty() {
        let mut rows: Vec<_> = categories.iter().collect();
        rows.sort_by_key(|(_, v)| std::cmp::Reverse(v.0));
        let _ = writeln!(out, "\nBy category (total, not in an idle interval):");
        for (c, (total, idle)) in rows {
            let _ = writeln!(out, "  {c:<12} {:>8}  {:>8}", fmt_duration(*total), fmt_duration(total - idle));
        }
    }
    if !apps.is_empty() {
        let mut rows: Vec<_> = apps.iter().collect();
        rows.sort_by_key(|(_, v)| std::cmp::Reverse(v.total));
        let _ = writeln!(out, "\nBy app (total, not in an idle interval), top 25:");
        for (exe, a) in rows.into_iter().take(25) {
            let _ = writeln!(
                out,
                "  {exe:<28} {:<10} {:>8}  {:>8}",
                a.category,
                fmt_duration(a.total),
                fmt_duration(a.total - a.idle)
            );
        }
    }
    if !gaps.is_empty() {
        let _ = writeln!(out, "\nGaps where nothing is known:");
        for ((s, e), reason) in gaps.iter().take(20) {
            let _ = writeln!(out, "  {}-{}  {reason}", clock(*s, &input.tz), clock(*e, &input.tz));
        }
        if gaps.len() > 20 {
            let _ = writeln!(out, "  ... and {} more", gaps.len() - 20);
        }
    }
    if !instants.is_empty() {
        let _ = writeln!(out, "\nEvents:");
        for (k, n) in &instants {
            let _ = writeln!(out, "  {k}: {n}");
        }
    }
    if clock_jumps > 0 {
        let _ = writeln!(out, "Clock jumps backwards: {clock_jumps}");
    }

    let _ = writeln!(out, "\nAgent cost:");
    if metrics.is_empty() {
        let _ = writeln!(out, "  no metrics for this day");
    } else {
        let cpu: i64 = metrics.iter().map(|m| m.cpu_ms).sum();
        let wall = metrics.len() as f64 * 60_000.0;
        let peak = metrics.iter().map(|m| m.rss_bytes).max().unwrap_or(0);
        let busiest = metrics.iter().map(|m| m.cpu_ms).max().unwrap_or(0) as f64 / 600.0;
        let dropped: i64 = metrics.iter().map(|m| m.dropped).sum();
        let _ = writeln!(
            out,
            "  CPU: {:.3}% of one core on average ({} minutes sampled, busiest minute {busiest:.2}%)",
            cpu as f64 / wall * 100.0,
            metrics.len()
        );
        let _ = writeln!(out, "  memory: {:.1} MB peak working set", peak as f64 / 1_048_576.0);
        let _ = writeln!(
            out,
            "  database: {:.2} MB, dropped signals: {dropped}",
            db_bytes as f64 / 1_048_576.0
        );
    }
    out
}
