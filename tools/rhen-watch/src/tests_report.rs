//! The "your day at the PC" section, the renamed headings, and how `run` and `report` load their settings.

use std::collections::HashMap;

use serde_json::json;

use crate::categories::{Catalogue, CategoryFile};
use crate::cli::{days_from_civil, load_report_settings, load_run_settings};
use crate::config::{Config, Derive};
use crate::derive::Params;
use crate::model::Op;
use crate::report::{ReportInput, build};
use crate::store::Store;
use crate::tz::{TzOffset, auckland};

const MIN: i64 = 60_000;
const DAY0: i64 = 20_000 * 86_400_000;

fn at(k: i64) -> i64 {
    DAY0 + k * MIN
}

fn params() -> Params {
    Params::from(&Derive::default())
}

fn bucket(k: i64, exe: &str, input_s: i64) -> Op {
    Op::Bucket {
        minute_ts: at(k),
        exe: exe.into(),
        run: 1,
        observed_ms: 60_000,
        input_ms: input_s * 1000,
    }
}

fn agent_start(ts: i64) -> Op {
    Op::Instant {
        source: "agent",
        kind: "start".into(),
        ts,
        end: None,
        attrs: Default::default(),
    }
}

fn app_rows(store: &mut Store, rows: &[(&str, i64, i64, &str)]) {
    // The agent's own start is the oldest event, as in a real database.
    let mut ops = vec![agent_start(at(rows.iter().map(|r| r.1).min().unwrap_or(0)) - MIN)];
    for (i, (exe, s, e, stored_category)) in rows.iter().enumerate() {
        ops.push(Op::Open {
            id: format!("a{i}"),
            source: "foreground",
            kind: "app".into(),
            ts: at(*s),
            attrs: crate::model::attrs([("exe", json!(exe)), ("category", json!(stored_category))]),
        });
        ops.push(Op::Close {
            id: format!("a{i}"),
            ts: at(*e),
        });
    }
    store.apply("d", &ops, at(0)).unwrap();
}

struct Setup {
    store: Store,
    catalogue: Catalogue,
    tz: TzOffset,
    idle_collector: bool,
    from: i64,
    to: i64,
    open_until: Option<i64>,
}

impl Setup {
    fn new() -> Self {
        Setup {
            store: Store::in_memory().unwrap(),
            catalogue: Catalogue::new(&HashMap::new(), &[]),
            tz: TzOffset::fixed(0),
            idle_collector: true,
            from: at(0),
            to: at(24 * 60),
            open_until: None,
        }
    }
    fn text(&self) -> String {
        let p = params();
        build(
            &self.store,
            &ReportInput {
                label: "2026-11-09",
                from: self.from,
                to: self.to,
                open_until: self.open_until.unwrap_or(self.to),
                tz: self.tz.clone(),
                catalogue: &self.catalogue,
                params: &p,
                idle_collector: self.idle_collector,
            },
        )
        .unwrap()
    }
}

/// A day with a morning of code, a short chat visit, an afternoon of browser, and some unclassified exe time.
fn busy_day() -> Setup {
    let mut s = Setup::new();
    let mut ops = Vec::new();
    for k in 540..556 {
        ops.push(bucket(k, "code.exe", 20));
    }
    for k in 556..558 {
        ops.push(bucket(k, "discord.exe", 20));
    }
    for k in 558..570 {
        ops.push(bucket(k, "code.exe", 20));
    }
    for k in 570..600 {
        ops.push(bucket(k, "code.exe", 0));
    }
    for k in 900..930 {
        ops.push(bucket(k, "chrome.exe", 15));
    }
    s.store.apply("d", &ops, at(0)).unwrap();
    app_rows(
        &mut s.store,
        &[
            ("code.exe", 540, 556, "editor"),
            ("discord.exe", 556, 558, "chat"),
            ("code.exe", 558, 600, "editor"),
            ("chrome.exe", 900, 930, "browser"),
            ("foo.exe", 930, 971, "other"),
        ],
    );
    s
}

/// Everything from the start of the new section to the first existing heading.
fn section(text: &str) -> &str {
    let start = text.find("Your day at the PC").expect("section present");
    let end = text.find("Activity for ").expect("existing report follows");
    assert!(start < end, "the new section comes first");
    &text[start..end]
}

// ---- the section ----

#[test]
fn the_day_section_comes_first_and_is_labelled_derived() {
    let t = busy_day().text();
    assert!(t.starts_with("Your day at the PC, "), "{t}");
    let head = t.lines().next().unwrap();
    assert!(head.contains("2026-11-09") && head.contains("UTC+00:00"), "{head}");
    assert!(head.contains("derived") && head.contains("not stored"), "{head}");
    assert!(
        head.starts_with("Your day at the PC, Fri 2026-11-09"),
        "the weekday comes from the day's instants: {head}"
    );
}

#[test]
fn a_scripted_day_prints_the_expected_section() {
    let t = busy_day().text();
    let want = "\
Your day at the PC, Fri 2026-11-09 (UTC+00:00)   [derived from the rows below; not stored]
  (partial: 811 min unknown)
  First input 09:00, last input 15:29   (first and last input of the day; not a claim about presence)
  Input: 18m in 5 s slots, 2h 11m in front, observed coverage 68%
  Longest unbroken stretch: 09:00-09:30 (30m; gaps of up to 5 min count as unbroken)
  Input blocks (browser): 15:00-15:30 30m active
  Input blocks (work): 09:00-09:30 28m active, 1 detour (2m)
  Switches: 1.4 per observed foreground hour between apps, 1.4 between groups
  Not categorised yet (add to [exe] in categories.toml, or run: rhen-watch categories set EXE CATEGORY):
    foo.exe  41m   \"foo.exe\" = \"...\"
  Browser time is kept apart from work: what a browser is used for cannot be told from its exe.
  Input includes synthetic input (remote tools, jigglers, scheduled tasks).
";
    assert_eq!(section(&t).trim_end(), want.trim_end(), "\n{}", section(&t));
}

#[test]
fn the_new_section_never_uses_state_words() {
    let forbidden = [
        "wake",
        "woke",
        "awake",
        "sleep",
        "rest",
        "tired",
        "energy",
        "capacity",
        "focus level",
    ];
    let mut cases = vec![busy_day().text()];
    let mut idle_off = Setup::new();
    idle_off.idle_collector = false;
    cases.push(idle_off.text());
    cases.push(Setup::new().text());
    let mut purged = Setup::new();
    purged.store.apply("d", &[bucket(540, "code.exe", 20)], at(0)).unwrap();
    cases.push(purged.text());
    for t in cases {
        let sec = section_or_all(&t).to_lowercase();
        let words: Vec<&str> = sec.split(|c: char| !c.is_alphanumeric()).collect();
        for w in forbidden {
            if w.contains(' ') {
                assert!(!sec.contains(w), "{w} in:\n{sec}");
            } else {
                assert!(!words.contains(&w), "{w} in:\n{sec}");
            }
        }
    }
}

fn section_or_all(text: &str) -> &str {
    match (text.find("Your day at the PC"), text.find("Activity for ")) {
        (Some(s), Some(e)) if s < e => &text[s..e],
        _ => text,
    }
}

#[test]
fn every_input_figure_carries_the_synthetic_input_caveat() {
    let t = busy_day().text();
    assert!(section(&t).contains("Input includes synthetic input (remote tools, jigglers, scheduled tasks)."));
    let t = Setup::new().text();
    assert!(!t.contains("Input:"), "no figures, no caveat needed: {t}");
}

#[test]
fn an_old_database_and_an_idle_collector_that_is_off_say_so_instead_of_printing_zeros() {
    // schema 1: no table at all
    let s = Setup::new();
    s.store.drop_input_buckets_for_test();
    assert!(s.text().contains("no input data (agent older than this report)"));
    // a current database with the idle collector off
    let mut s = Setup::new();
    s.idle_collector = false;
    let t = s.text();
    assert!(t.contains("no input data (idle collector off)"), "{t}");
    assert!(!t.contains("Input: 0"), "never zeros");
    // nothing for the day, collector on
    assert!(Setup::new().text().contains("no input data for this day"));
}

#[test]
fn input_rows_whose_events_are_purged_print_partial_and_no_facts() {
    let mut s = Setup::new();
    s.store
        .apply("d", &[bucket(540, "code.exe", 20), bucket(541, "code.exe", 20)], at(0))
        .unwrap();
    let t = s.text();
    assert!(section(&t).contains("partial: events purged"), "{t}");
    assert!(!section(&t).contains("First input"));
}

#[test]
fn a_day_known_for_under_80_percent_says_how_many_minutes_are_unknown() {
    // recorded from the agent start at 08:59 to the end of the day: 901 minutes, of which 90 were watched
    let t = busy_day().text();
    assert!(section(&t).contains("(partial: 811 min unknown)"), "{t}");
}

#[test]
fn minutes_that_have_not_happened_yet_and_minutes_before_the_first_record_are_not_unknown() {
    // the same day viewed at 16:11: recorded from 08:59 to 16:11 = 432 minutes, 90 watched
    let mut s = busy_day();
    s.open_until = Some(at(971));
    let t = s.text();
    assert!(section(&t).contains("(partial: 342 min unknown)"), "{t}");
    // a day watched from its first record to "now" is not partial, however early it is
    let mut s = Setup::new();
    let ops: Vec<Op> = (540..600).map(|k| bucket(k, "code.exe", 20)).collect();
    s.store.apply("d", &ops, at(0)).unwrap();
    app_rows(&mut s.store, &[("code.exe", 540, 600, "editor")]);
    s.open_until = Some(at(600));
    let t = s.text();
    assert!(!section(&t).contains("partial"), "{t}");
}

#[test]
fn old_databases_rows_are_read_alongside_new_ones() {
    // a database written by an agent that never had buckets still reports its events
    let mut s = Setup::new();
    app_rows(&mut s.store, &[("code.exe", 540, 600, "editor")]);
    s.store.drop_input_buckets_for_test();
    let t = s.text();
    assert!(t.contains("code.exe"), "{t}");
}

// ---- headings and categories ----

#[test]
fn active_has_one_meaning_and_asleep_is_renamed() {
    let t = busy_day().text();
    assert!(t.contains("In front and not in an idle interval:"), "{t}");
    assert!(t.contains("By category (total, not in an idle interval):"), "{t}");
    assert!(t.contains("By app (total, not in an idle interval), top 25:"), "{t}");
    assert!(!t.contains("Active in front") && !t.contains("(total, active)"), "{t}");
    let mut s = Setup::new();
    s.store
        .apply(
            "d",
            &[
                Op::Open {
                    id: "p".into(),
                    source: "power",
                    kind: "suspended".into(),
                    ts: at(10),
                    attrs: Default::default(),
                },
                Op::Close {
                    id: "p".into(),
                    ts: at(70),
                },
            ],
            at(0),
        )
        .unwrap();
    let t = s.text();
    assert!(t.contains("Suspended: 1h 00m") && !t.contains("Asleep"), "{t}");
}

#[test]
fn the_report_re_resolves_categories_from_the_current_map_not_the_stored_one() {
    let mut s = busy_day();
    let before = s.text();
    assert!(before.contains("foo.exe") && before.contains("other"));
    let file = CategoryFile::parse("[exe]\n\"foo.exe\" = \"media\"\n\"code.exe\" = \"terminal\"\n").unwrap();
    s.catalogue = Catalogue::with_file(&file, &[]);
    let after = s.text();
    let row = after
        .lines()
        .find(|l| l.trim_start().starts_with("foo.exe") && l.contains("media"))
        .expect("relabelled");
    assert!(row.contains("41m"), "{row}");
    assert!(
        after
            .lines()
            .any(|l| l.trim_start().starts_with("code.exe") && l.contains("terminal")),
        "{after}"
    );
    assert!(
        !section(&after).contains("Not categorised yet"),
        "labelling removes it from the list"
    );
}

#[test]
fn not_categorised_lists_at_most_15_exes_by_time_in_front() {
    let mut s = Setup::new();
    let mut ops = vec![bucket(1, "code.exe", 20)];
    let mut rows = Vec::new();
    for i in 0..20 {
        rows.push((format!("zz{i:02}.exe"), 10 + i * 20, 10 + i * 20 + 1 + i, "other"));
    }
    let borrowed: Vec<(&str, i64, i64, &str)> = rows.iter().map(|(e, a, b, c)| (e.as_str(), *a, *b, *c)).collect();
    app_rows(&mut s.store, &borrowed);
    ops.push(bucket(2, "code.exe", 20));
    s.store.apply("d", &ops, at(0)).unwrap();
    let t = s.text();
    let sec = section(&t);
    let listed = sec.lines().filter(|l| l.contains("= \"...\"")).count();
    assert_eq!(listed, 15, "{sec}");
    assert!(sec.contains("zz19.exe") && !sec.contains("zz00.exe"));
}

#[test]
fn a_category_with_no_group_is_noted() {
    let mut s = busy_day();
    let file = CategoryFile::parse("[exe]\n\"foo.exe\" = \"hobby\"\n").unwrap();
    s.catalogue = Catalogue::with_file(&file, &[]);
    let t = s.text();
    assert!(section(&t).contains("hobby") && section(&t).contains("no group"), "{t}");
}

// ---- days and DST ----

#[test]
fn the_report_for_a_dst_day_uses_that_days_own_window_and_labels() {
    let mut s = Setup::new();
    s.tz = auckland();
    let (from, to) = s.tz.day_window(days_from_civil(2026, 4, 5));
    s.from = from;
    s.to = to;
    s.store
        .apply(
            "d",
            &[
                Op::Bucket {
                    minute_ts: from + 150 * MIN,
                    exe: "code.exe".into(),
                    run: 1,
                    observed_ms: 60_000,
                    input_ms: 30_000,
                },
                Op::Bucket {
                    minute_ts: from + 210 * MIN,
                    exe: "code.exe".into(),
                    run: 1,
                    observed_ms: 60_000,
                    input_ms: 30_000,
                },
            ],
            from,
        )
        .unwrap();
    app_rows_at(&mut s.store, from, to);
    let t = s.text();
    assert!(t.lines().next().unwrap().contains("UTC+13:00"), "{t}");
    assert!(
        t.contains("Activity for 2026-11-09 (UTC+13:00 then UTC+12:00)"),
        "both offsets on a DST day: {t}"
    );
    assert!(
        t.contains("First input 02:30, last input 02:30"),
        "both at 02:30, an hour apart: {t}"
    );
}

fn app_rows_at(store: &mut Store, from: i64, to: i64) {
    store
        .apply(
            "d",
            &[
                agent_start(from),
                Op::Open {
                    id: "a".into(),
                    source: "foreground",
                    kind: "app".into(),
                    ts: from,
                    attrs: crate::model::attrs([("exe", json!("code.exe")), ("category", json!("editor"))]),
                },
                Op::Close { id: "a".into(), ts: to },
            ],
            from,
        )
        .unwrap();
}

// ---- settings for run and report ----

fn tmp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rhen-watch-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_legacy_categories_table_stops_both_run_and_report_with_the_one_line() {
    let dir = tmp("legacy");
    std::fs::write(dir.join("config.toml"), "[categories]\n\"foo.exe\" = \"editor\"\n").unwrap();
    let want = "config.toml has a [categories] table; move it to categories.toml (run: rhen-watch categories init --from-config)";
    assert_eq!(load_report_settings(&dir).err().unwrap(), want);
    assert_eq!(load_run_settings(&dir).err().unwrap(), want);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_bad_categories_file_fails_report_but_run_degrades_and_records() {
    let dir = tmp("badcat");
    std::fs::write(dir.join("categories.toml"), "[exe]\n\"foo.exe\" = \n").unwrap();
    let e = load_report_settings(&dir).err().unwrap();
    assert!(e.contains("categories.toml") && e.contains("line 2"), "{e}");
    let (_cfg, catalogue, problem) = load_run_settings(&dir).unwrap();
    assert!(
        problem.unwrap().contains("categories.toml"),
        "reported so run can log it and write one degraded marker"
    );
    assert_eq!(
        catalogue.lookup("code.exe"),
        Some("editor"),
        "recording continues with the built-in categories"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn good_settings_load_and_a_missing_directory_of_files_is_defaults() {
    let dir = tmp("good");
    let (cfg, catalogue) = load_report_settings(&dir).unwrap();
    assert_eq!(cfg.derive, Config::default().derive);
    assert_eq!(catalogue.lookup("code.exe"), Some("editor"));
    std::fs::write(dir.join("categories.toml"), "[exe]\n\"foo.exe\" = \"notes\"\n").unwrap();
    let (_, catalogue, problem) = load_run_settings(&dir).unwrap();
    assert!(problem.is_none());
    assert_eq!(catalogue.lookup("foo.exe"), Some("notes"));
    let _ = std::fs::remove_dir_all(&dir);
}
