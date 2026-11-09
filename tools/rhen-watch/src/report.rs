//! `rhen-watch report`: what was captured on one day, as plain text.

use std::collections::BTreeMap;
use std::fmt::Write;

use crate::model::{Ms, SRC_AGENT, SRC_FOREGROUND, SRC_IDLE, SRC_POWER, SRC_SESSION};
use crate::store::{EventRow, MetricRow, Store};

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
    pub offset_min: i32,
}

pub fn build(store: &Store, input: &ReportInput) -> Result<String, String> {
    let mut events = store.events_between(input.from, input.to).map_err(|e| e.to_string())?;
    events.extend(store.open_rows().into_iter().filter(|e| e.ts_start < input.to));
    events.sort_by_key(|e| e.ts_start);
    let metrics = store.metrics_between(input.from, input.to).map_err(|e| e.to_string())?;
    Ok(render(&events, &metrics, input, store.db_bytes()))
}

pub fn render(events: &[EventRow], metrics: &[MetricRow], input: &ReportInput, db_bytes: i64) -> String {
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
    let mut gaps: Vec<(Span, String)> = Vec::new();
    let mut instants: BTreeMap<String, usize> = BTreeMap::new();
    let mut clock_jumps = 0;
    for e in events {
        let Some(s) = span(e) else { continue };
        let len = s.1 - s.0;
        match (e.source.as_str(), e.kind.as_str()) {
            (SRC_FOREGROUND, "app") => {
                let exe = e.attrs["exe"].as_str().unwrap_or("?").to_string();
                let entry = apps.entry(exe).or_default();
                entry.category = e.attrs["category"].as_str().unwrap_or("other").to_string();
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
            (SRC_AGENT, "clock_jump") => clock_jumps += 1,
            (SRC_IDLE, _) => {}
            (src, kind) if e.ts_end == Some(e.ts_start) => {
                *instants.entry(format!("{src}/{kind}")).or_default() += 1;
            }
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

    let mut out = String::new();
    let _ = writeln!(out, "Activity for {} ({})", input.label, fmt_offset(input.offset_min));
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
    let _ = writeln!(out, "Active in front: {}", fmt_duration(fg_total - idle_in_fg));
    for (label, ms) in [
        ("Screen locked", locked),
        ("Asleep/suspended", asleep),
        ("Display off", display_off),
        ("Remote session", remote),
        ("Suppressed (game in front)", suppressed),
        ("Window unreadable", unreadable),
        ("Unknown (agent not running or machine stalled)", unknown),
    ] {
        if ms > 0 {
            let _ = writeln!(out, "{label}: {}", fmt_duration(ms));
        }
    }
    if !categories.is_empty() {
        let mut rows: Vec<_> = categories.iter().collect();
        rows.sort_by_key(|(_, v)| std::cmp::Reverse(v.0));
        let _ = writeln!(out, "\nBy category (total, active):");
        for (c, (total, idle)) in rows {
            let _ = writeln!(out, "  {c:<12} {:>8}  {:>8}", fmt_duration(*total), fmt_duration(total - idle));
        }
    }
    if !apps.is_empty() {
        let mut rows: Vec<_> = apps.iter().collect();
        rows.sort_by_key(|(_, v)| std::cmp::Reverse(v.total));
        let _ = writeln!(out, "\nBy app (total, active), top 25:");
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
            let _ = writeln!(
                out,
                "  {}-{}  {reason}",
                fmt_clock(*s, input.offset_min),
                fmt_clock(*e, input.offset_min)
            );
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
