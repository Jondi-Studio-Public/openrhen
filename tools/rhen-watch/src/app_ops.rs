//! What the settings window does with the data folder, as plain functions of a directory so they are tested on any
//! OS: reading the agent's state files, today's report, the apps with no category, setting a category, and reading,
//! checking and saving the settings. They reuse the command line's own code (`report_days`, `categories::set_entry`,
//! `config::set_key`), so a value means the same thing whichever way it was set. Nothing here touches a window, a
//! scheduled task or a process.

use std::path::Path;

use crate::app_model::{
    AgentFacts, AppRow, Keep, STATE_FILE, SettingsPlan, app_rows, categories_in_use, keep_from_retention, settings_writes,
};
use crate::categories::{self, CategoryFile};
use crate::cli;
use crate::config::{self, Config};
use crate::model::Ms;
use crate::store::Store;

const DAY_MS: i64 = 86_400_000;

/// The state files plus the two probes the caller made (`lock_held`, `window_found`).
pub fn read_facts(dir: &Path, lock_held: bool, window_found: bool) -> AgentFacts {
    AgentFacts {
        lock_held,
        window_found,
        state_file: std::fs::read_to_string(dir.join(STATE_FILE)).ok(),
        not_starting: std::fs::read_to_string(dir.join(cli::NOT_STARTING_FILE)).ok(),
    }
}

/// Today's report, as `rhen-watch report` prints it. No database yet is a sentence, not an error.
pub fn report_text(dir: &Path, now: Ms) -> Result<String, String> {
    let (cfg, catalogue) = cli::load_report_settings(dir)?;
    let db = dir.join("activity.db");
    if !db.exists() {
        return Ok("Nothing recorded yet.\n".to_string());
    }
    let tz = cli::local_tz();
    let store = Store::open_read_only(&db).map_err(|e| e.to_string())?;
    cli::report_days(&store, &cfg, &catalogue, &tz, now, &[tz.day_of(now)])
}

pub struct AppsData {
    pub rows: Vec<AppRow>,
    pub categories: Vec<String>,
}

/// The apps with no category yet (time in front, longest first) and the categories in use.
pub fn load_apps(dir: &Path) -> Result<AppsData, String> {
    let file = CategoryFile::load(&dir.join("categories.toml"))?;
    let catalogue = categories::Catalogue::with_file(&file, &[]);
    let categories = categories_in_use(&catalogue.entries(&file));
    let db = dir.join("activity.db");
    if !db.exists() {
        return Ok(AppsData {
            rows: Vec::new(),
            categories,
        });
    }
    let store = Store::open_read_only(&db).map_err(|e| e.to_string())?;
    let totals = store.app_time_totals().map_err(|e| e.to_string())?;
    let catalogue = catalogue.with_declared(store.declared_apps().map_err(|e| e.to_string())?);
    Ok(AppsData {
        rows: app_rows(&totals, &catalogue),
        categories,
    })
}

/// `categories set EXE CATEGORY`, written atomically. Returns the line to show.
pub fn set_category(dir: &Path, exe: &str, category: &str) -> Result<String, String> {
    let path = dir.join("categories.toml");
    let existing = config::read_text(&path, "categories.toml")?;
    let (text, warnings) = categories::set_entry(existing.as_deref(), exe, category.trim())?;
    config::write_atomic(&path, &text)?;
    for w in warnings {
        crate::log::warn(&w);
    }
    Ok(format!(
        "{} = {}. {}",
        exe.to_ascii_lowercase(),
        category.trim(),
        crate::app_model::RESTART_NOTE
    ))
}

#[derive(Debug, Clone, PartialEq)]
pub struct SettingsData {
    pub keep: Keep,
    pub idle_secs: u64,
}

/// The settings the Settings tab shows. A broken `config.toml` is an error here: the window says so rather than
/// showing defaults the file does not have.
pub fn load_settings(dir: &Path) -> Result<SettingsData, String> {
    let cfg = Config::load(&dir.join("config.toml"))?;
    cfg.reject_legacy_categories()?;
    Ok(SettingsData {
        keep: keep_from_retention(&cfg.retention.events)?,
        idle_secs: cfg.idle_threshold_secs.unwrap_or(config::DEFAULT_IDLE_THRESHOLD_SECS),
    })
}

/// The question to put to the user before `keep` is saved, if it would delete anything recorded.
pub fn retention_question(dir: &Path, keep: Keep, now: Ms) -> Result<Option<String>, String> {
    let Keep::Days(days) = keep else { return Ok(None) };
    let db = dir.join("activity.db");
    if !db.exists() {
        return Ok(None);
    }
    let store = Store::open_read_only(&db).map_err(|e| e.to_string())?;
    let older = store
        .count_events_before(now - i64::from(days) * DAY_MS)
        .map_err(|e| e.to_string())?;
    let buckets = store
        .count_buckets_before(now - i64::from(days) * DAY_MS)
        .map_err(|e| e.to_string())?;
    let oldest = store
        .earliest_event_end()
        .map_err(|e| e.to_string())?
        .map(|t| ((now - t) / DAY_MS).max(0));
    Ok(crate::app_model::retention_confirm(keep, older, buckets, oldest))
}

/// Save the Settings tab. Everything is checked before anything is written, and a `config.toml` that is already
/// broken is left alone (the user is told to fix it), so a save never makes a bad file worse or papers over it.
pub fn apply_settings(dir: &Path, plan: &SettingsPlan) -> Result<String, String> {
    let path = dir.join("config.toml");
    let existing = config::read_text(&path, "config.toml")?;
    if let Some(text) = &existing {
        let cfg = Config::parse(text).map_err(|e| format!("config.toml already has a problem: {e}; fix it first"))?;
        cfg.reject_legacy_categories()
            .map_err(|e| format!("config.toml already has a problem: {e}"))?;
    }
    let mut text = existing.unwrap_or_else(|| config::TEMPLATE.to_string());
    for (key, value) in settings_writes(plan) {
        text = config::set_key(&text, key, &value)?;
    }
    Config::parse(&text)?.validate()?;
    config::write_atomic(&path, &text)?;
    Ok("Saved. Retention and the idle threshold take effect when recording restarts.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_model::{RunState, plan_settings, resolve_state};
    use crate::model::Op;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rhen-watch-appops-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn instant(ts: i64) -> Op {
        Op::Instant {
            source: "agent",
            kind: "start".into(),
            ts,
            end: None,
            attrs: Default::default(),
        }
    }

    #[test]
    fn facts_come_from_the_state_files() {
        let dir = tmp("facts");
        assert_eq!(resolve_state(&read_facts(&dir, false, false)), RunState::NotRunning);
        std::fs::write(dir.join(STATE_FILE), "paused").unwrap();
        assert_eq!(resolve_state(&read_facts(&dir, true, true)), RunState::Paused);
        std::fs::write(dir.join("not-starting.txt"), "config.toml: bad").unwrap();
        assert_eq!(
            resolve_state(&read_facts(&dir, false, false)),
            RunState::NotStarting("config.toml: bad".into())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_report_says_so_when_nothing_is_recorded_and_names_a_bad_config() {
        let dir = tmp("report");
        assert_eq!(report_text(&dir, 1_000).unwrap(), "Nothing recorded yet.\n");
        std::fs::write(dir.join("config.toml"), "idle_treshold_secs = 1\n").unwrap();
        assert!(report_text(&dir, 1_000).unwrap_err().contains("idle_treshold_secs"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_report_is_todays_report() {
        let dir = tmp("report-today");
        let now = cli::days_from_civil(2026, 11, 10) * DAY_MS + 12 * 3_600_000;
        Store::open(&dir.join("activity.db"))
            .unwrap()
            .apply("d", &[instant(now - 60_000)], now)
            .unwrap();
        let text = report_text(&dir, now).unwrap();
        assert!(text.contains("Activity for 2026-11-10"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn setting_a_category_writes_the_same_file_the_command_line_does() {
        let dir = tmp("setcat");
        let msg = set_category(&dir, "Foo.exe", " editor ").unwrap();
        assert!(msg.starts_with("foo.exe = editor."), "{msg}");
        assert!(msg.contains("when recording restarts"), "{msg}");
        let file = CategoryFile::load(&dir.join("categories.toml")).unwrap();
        assert_eq!(file.exe.get("foo.exe").map(String::as_str), Some("editor"));
        assert!(!dir.join("categories.toml.tmp").exists());
        assert!(set_category(&dir, "", "editor").is_err());
        assert!(set_category(&dir, "bar.exe", "").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_apps_list_is_empty_without_a_database_and_the_category_box_still_fills() {
        let dir = tmp("apps");
        let data = load_apps(&dir).unwrap();
        assert!(data.rows.is_empty());
        assert!(data.categories.iter().any(|c| c == "editor"), "{:?}", data.categories);
        std::fs::write(dir.join("categories.toml"), "[exe\n").unwrap();
        assert!(load_apps(&dir).is_err(), "a bad categories file is said, not hidden");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_load_as_the_file_has_them_and_save_through_config_set_s_validator() {
        let dir = tmp("settings");
        assert_eq!(
            load_settings(&dir).unwrap(),
            SettingsData {
                keep: Keep::Forever,
                idle_secs: 120
            }
        );
        let plan = plan_settings("90 days", "300").unwrap();
        apply_settings(&dir, &plan).unwrap();
        assert_eq!(
            load_settings(&dir).unwrap(),
            SettingsData {
                keep: Keep::Days(90),
                idle_secs: 300
            }
        );
        let text = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(text.contains("# Seconds without keyboard or mouse input"), "comments are kept");
        let cfg = Config::parse(&text).unwrap();
        assert_eq!(cfg.retention.input_buckets, crate::config::Retention::Days(90));
        assert_eq!(
            cfg.retention.metrics,
            crate::config::Retention::Word("permanent".into()),
            "metrics retention is not touched"
        );
        apply_settings(&dir, &plan_settings("Forever", "120").unwrap()).unwrap();
        assert_eq!(load_settings(&dir).unwrap().keep, Keep::Forever);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_with_a_bad_value_changes_nothing() {
        let dir = tmp("settings-bad");
        apply_settings(&dir, &plan_settings("30", "100").unwrap()).unwrap();
        let before = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        let err = apply_settings(&dir, &plan_settings("30", "0").unwrap()).unwrap_err();
        assert!(err.contains("idle_threshold_secs"), "{err}");
        let err = apply_settings(&dir, &plan_settings("30", "999999").unwrap()).unwrap_err();
        assert!(err.contains("between 1 and"), "{err}");
        assert_eq!(std::fs::read_to_string(dir.join("config.toml")).unwrap(), before);
        assert!(!dir.join("config.toml.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_config_that_is_already_broken_is_not_overwritten() {
        let dir = tmp("settings-broken");
        std::fs::write(dir.join("config.toml"), "idle_treshold_secs = 1\n").unwrap();
        let err = apply_settings(&dir, &plan_settings("30", "100").unwrap()).unwrap_err();
        assert!(err.contains("already has a problem") && err.contains("fix it first"), "{err}");
        assert_eq!(
            std::fs::read_to_string(dir.join("config.toml")).unwrap(),
            "idle_treshold_secs = 1\n"
        );
        assert!(load_settings(&dir).is_err());
        std::fs::write(dir.join("config.toml"), "[categories]\n\"x.exe\" = \"editor\"\n").unwrap();
        assert!(
            apply_settings(&dir, &plan_settings("30", "100").unwrap())
                .unwrap_err()
                .contains("categories.toml")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_shorter_retention_counts_what_it_would_delete_from_the_database() {
        let dir = tmp("retention");
        let now = 400 * DAY_MS;
        assert_eq!(
            retention_question(&dir, Keep::Days(30), now).unwrap(),
            None,
            "no database, nothing to delete"
        );
        let mut store = Store::open(&dir.join("activity.db")).unwrap();
        for age_days in [100, 95, 50, 2] {
            store
                .apply("d", &[instant(now - age_days * DAY_MS)], now - age_days * DAY_MS)
                .unwrap();
        }
        drop(store);
        let q = retention_question(&dir, Keep::Days(30), now).unwrap().unwrap();
        assert!(
            q.contains("3 recorded events") && q.contains("the oldest event is 100 days old"),
            "{q}"
        );
        let q = retention_question(&dir, Keep::Days(60), now).unwrap().unwrap();
        assert!(q.contains("2 recorded events"), "{q}");
        assert_eq!(retention_question(&dir, Keep::Days(365), now).unwrap(), None);
        assert_eq!(retention_question(&dir, Keep::Forever, now).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
