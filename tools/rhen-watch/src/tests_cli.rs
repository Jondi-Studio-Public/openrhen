//! What the command line says about a bad config, an old database and a failed start. Pure helpers, any OS.

use crate::cli;
use crate::store::Store;

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("rhen-watch-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const LEGACY: &str = "[categories]\n\"x.exe\" = \"editor\"\n";

#[test]
fn status_says_a_bad_config_stops_the_agent() {
    let dir = temp("status-bad");
    std::fs::write(dir.join("config.toml"), "idle_treshold_secs = 1\n").unwrap();
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("settings: ERROR"), "{text}");
    assert!(text.contains("idle_treshold_secs"), "{text}");
    assert!(text.contains("(the agent will not start)"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn status_says_a_legacy_categories_table_stops_the_agent() {
    let dir = temp("status-legacy");
    std::fs::write(dir.join("config.toml"), LEGACY).unwrap();
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("settings: ERROR") && text.contains("categories.toml"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn status_says_ok_for_good_settings_and_names_a_bad_categories_file() {
    let dir = temp("status-ok");
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("settings: ok"), "{text}");
    std::fs::write(dir.join("categories.toml"), "[exe\n").unwrap();
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("settings: ok"), "{text}");
    assert!(text.contains("categories.toml") && text.contains("built-in categories"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn config_show_prints_the_settings_error_instead_of_failing() {
    let dir = temp("show-bad");
    std::fs::write(dir.join("config.toml"), "idle_threshold_secs = \"x\"\n").unwrap();
    let text = cli::config_show_text(&dir).unwrap();
    assert!(
        text.contains("settings: ERROR") && text.contains("(the agent will not start)"),
        "{text}"
    );
    std::fs::write(dir.join("config.toml"), LEGACY).unwrap();
    let text = cli::config_show_text(&dir).unwrap();
    assert!(text.contains("idle_threshold_secs"), "the settings are still listed: {text}");
    assert!(text.contains("settings: ERROR") && text.contains("categories.toml"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn status_leaves_a_schema_1_database_alone_and_shows_its_version() {
    let dir = temp("status-v1");
    let db = dir.join("activity.db");
    {
        let s = Store::open(&db).unwrap();
        s.set_meta("schema_version", "1").unwrap();
    }
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("schema version: 1"), "{text}");
    let s = Store::open_read_only(&db).unwrap();
    assert_eq!(s.schema_version().unwrap(), Some(1), "status must not migrate");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn status_works_on_a_newer_schema() {
    let dir = temp("status-v9");
    let db = dir.join("activity.db");
    {
        let s = Store::open(&db).unwrap();
        s.set_meta("schema_version", "9").unwrap();
    }
    let text = cli::status_text(&dir).unwrap();
    assert!(text.contains("schema version: 9"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn install_refuses_a_config_the_agent_would_reject() {
    let dir = temp("install");
    assert!(cli::check_settings_for_install(&dir).is_ok());
    std::fs::write(dir.join("config.toml"), "[retention]\nevents = -3\n").unwrap();
    let err = cli::check_settings_for_install(&dir).unwrap_err();
    assert!(err.contains("config.toml"), "{err}");
    assert!(err.contains("nothing was installed"), "{err}");
    std::fs::write(dir.join("config.toml"), LEGACY).unwrap();
    assert!(cli::check_settings_for_install(&dir).unwrap_err().contains("categories.toml"));
    std::fs::write(dir.join("config.toml"), "").unwrap();
    std::fs::write(dir.join("categories.toml"), "[exe\n").unwrap();
    assert!(cli::check_settings_for_install(&dir).is_ok(), "a bad categories.toml only degrades");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_run_gets_a_message_box_but_a_duplicate_start_does_not() {
    let run = vec!["run".to_string()];
    assert_eq!(cli::error_box_title(&run, false, "boom"), Some("rhen-watch did not start"));
    assert_eq!(
        cli::error_box_title(&run, true, "cannot write to the database"),
        Some("rhen-watch stopped")
    );
    assert_eq!(cli::error_box_title(&run, false, cli::ALREADY_RUNNING), None);
    assert_eq!(cli::error_box_title(&run, true, cli::ALREADY_RUNNING), None);
    assert_eq!(cli::error_box_title(&["status".to_string()], false, "boom"), None);
    assert_eq!(cli::error_box_title(&[], false, "boom"), None);
}

#[test]
fn status_prints_the_settings_lines_before_a_database_error() {
    let dir = temp("status-corrupt");
    std::fs::write(
        dir.join("activity.db"),
        b"this is not a database, just text padding to fill a page......",
    )
    .unwrap();
    let mut out = String::new();
    let result = cli::status_report(&dir, &mut out);
    assert!(result.is_err());
    assert!(out.contains("settings: ok") && out.contains("agent:"), "{out}");
    let _ = std::fs::remove_dir_all(&dir);
}
