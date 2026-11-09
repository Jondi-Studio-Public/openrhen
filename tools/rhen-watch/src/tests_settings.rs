//! categories.toml, the retired config.toml [categories] table, `config show|set` and `categories` edits.

use std::collections::HashMap;

use crate::categories::{self, Catalogue, CategoryFile};
use crate::config::{self, Config};
use crate::tray::{TrayAction, action_for};

fn default_catalogue() -> Catalogue {
    Catalogue::new(&HashMap::new(), &[])
}

// ---- categories.toml ----

#[test]
fn a_missing_categories_file_is_valid_and_means_the_shipped_defaults() {
    let dir = std::env::temp_dir().join(format!("rhen-watch-cat-missing-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = CategoryFile::load(&dir.join("categories.toml")).unwrap();
    assert!(f.exe.is_empty() && f.group.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn exe_and_group_tables_override_the_defaults() {
    let f = CategoryFile::parse("[exe]\n\"Foo.EXE\" = \"editor\"\n\"chrome.exe\" = \"play\"\n[group]\nplay = \"play\"\nmine = \"work\"\n")
        .unwrap();
    let c = Catalogue::with_file(&f, &[]);
    assert_eq!(c.lookup("foo.exe"), Some("editor"));
    assert_eq!(c.lookup("chrome.exe"), Some("play"), "the file wins over the shipped default");
    assert_eq!(c.lookup("code.exe"), Some("editor"), "untouched defaults stay");
    assert_eq!(c.group_of_category("mine"), "work");
    assert_eq!(c.group_of_category("editor"), "work");
}

#[test]
fn lookup_is_none_for_an_exe_in_no_table_and_category_stays_other() {
    let c = default_catalogue();
    assert_eq!(c.lookup("mystery.exe"), None);
    assert_eq!(c.category("mystery.exe"), "other");
    let f = CategoryFile::parse("[exe]\n\"mystery.exe\" = \"other\"\n").unwrap();
    assert_eq!(
        Catalogue::with_file(&f, &[]).lookup("mystery.exe"),
        Some("other"),
        "a deliberate other is not uncategorised"
    );
}

#[test]
fn every_shipped_category_has_a_group_and_every_group_is_known() {
    let c = default_catalogue();
    assert!(c.groupless().is_empty(), "{:?}", c.groupless());
    for (_, cat) in categories::DEFAULT_CATEGORIES {
        assert!(categories::GROUPS.contains(&c.group_of_category(cat)), "{cat}");
        assert_ne!(c.group_of_category(cat), "", "{cat}");
    }
    assert_eq!(c.group_of_category("browser"), "browser");
    assert_eq!(c.group_of_category("games"), "play");
    assert_eq!(c.group_of_category("chat"), "comms");
}

#[test]
fn a_category_with_no_group_is_reported_and_falls_back_to_other() {
    let f = CategoryFile::parse("[exe]\n\"foo.exe\" = \"hobby\"\n").unwrap();
    let c = Catalogue::with_file(&f, &[]);
    assert_eq!(c.groupless(), vec!["hobby".to_string()]);
    assert_eq!(c.group_of_category("hobby"), "other");
}

#[test]
fn a_bad_categories_file_is_refused_with_the_reason() {
    for (text, needle) in [
        ("[exe]\n\"foo\" = \"editor\"\n", ".exe"),
        ("[exe]\n\"foo.exe\" = \"two words\"\n", "category"),
        ("[exe]\n\"foo.exe\" = \"\"\n", "category"),
        ("[group]\nhobby = \"fun\"\n", "group"),
        ("[typo]\nx = 1\n", "typo"),
        ("[exe]\n\"foo.exe\" = \n", "line 2"),
    ] {
        let e = CategoryFile::parse(text).unwrap_err();
        assert!(e.contains("categories.toml") && e.contains(needle), "{text:?} -> {e}");
    }
}

#[test]
fn an_invalid_file_on_disk_names_the_file_and_run_falls_back_to_defaults() {
    let dir = std::env::temp_dir().join(format!("rhen-watch-cat-bad-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("categories.toml");
    std::fs::write(&path, "[exe]\n\"foo.exe\" = \n").unwrap();
    let e = CategoryFile::load(&path).unwrap_err();
    assert!(e.contains("categories.toml") && e.contains("line 2"), "{e}");
    let (file, err) = categories::load_or_default(&path);
    assert!(err.is_some() && file.exe.is_empty(), "run records with compiled defaults");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn bom_is_stripped_and_utf16_gets_a_save_as_utf8_error() {
    let mut with_bom = vec![0xEF, 0xBB, 0xBF];
    with_bom.extend_from_slice(b"[exe]\n\"foo.exe\" = \"editor\"\n");
    assert!(config::decode_text(&with_bom, "categories.toml").unwrap().starts_with("[exe]"));
    let utf16: Vec<u8> = [0xFF, 0xFE]
        .into_iter()
        .chain("[exe]\n".encode_utf16().flat_map(|u| u.to_le_bytes()))
        .collect();
    for name in ["categories.toml", "config.toml"] {
        let e = config::decode_text(&utf16, name).unwrap_err();
        assert!(e.contains("UTF-8") && e.contains(name), "{e}");
    }
    let e = config::decode_text(&[0xFE, 0xFF, 0, 0x5B], "config.toml").unwrap_err();
    assert!(e.contains("UTF-8"), "{e}");
    assert!(config::decode_text(&[0xC3, 0x28], "config.toml").unwrap_err().contains("UTF-8"));
}

#[test]
fn categories_init_writes_every_shipped_default_with_comments_and_equals_the_defaults() {
    let text = categories::init_text();
    assert!(text.contains('#'));
    let f = CategoryFile::parse(&text).unwrap();
    let c = Catalogue::with_file(&f, &[]);
    for (exe, cat) in categories::DEFAULT_CATEGORIES {
        assert_eq!(c.lookup(exe), Some(*cat));
        assert!(text.contains(&format!("\"{exe}\"")), "{exe}");
    }
    assert!(c.groupless().is_empty());
    for (cat, group) in categories::DEFAULT_GROUPS {
        assert_eq!(c.group_of_category(cat), *group);
    }
}

#[test]
fn categories_set_adds_or_changes_one_entry_and_keeps_comments() {
    let start = "# my notes\n[exe]\n# the editor\n\"foo.exe\" = \"editor\"   # keep me\n\n[group]\n";
    let (text, warnings) = categories::set_entry(Some(start), "Foo.exe", "notes").unwrap();
    assert!(
        text.contains("# my notes") && text.contains("# the editor") && text.contains("# keep me"),
        "{text}"
    );
    assert!(warnings.is_empty());
    let f = CategoryFile::parse(&text).unwrap();
    assert_eq!(f.exe["foo.exe"], "notes");
    let (text, _) = categories::set_entry(Some(&text), "bar.exe", "editor").unwrap();
    let f = CategoryFile::parse(&text).unwrap();
    assert_eq!((f.exe["foo.exe"].as_str(), f.exe["bar.exe"].as_str()), ("notes", "editor"));
    // from nothing at all
    let (text, _) = categories::set_entry(None, "baz.exe", "media").unwrap();
    assert_eq!(CategoryFile::parse(&text).unwrap().exe["baz.exe"], "media");
}

#[test]
fn categories_set_validates_exe_and_category_and_warns_on_a_groupless_category() {
    assert!(categories::set_entry(None, "foo", "editor").unwrap_err().contains(".exe"));
    assert!(
        categories::set_entry(None, "foo.exe", "two words")
            .unwrap_err()
            .contains("category")
    );
    assert!(categories::set_entry(None, "foo.exe", "").unwrap_err().contains("category"));
    assert!(categories::set_entry(None, "foo.exe", "a/b").unwrap_err().contains("category"));
    let (_, warnings) = categories::set_entry(None, "foo.exe", "hobby").unwrap();
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("hobby") && warnings[0].contains("group"), "{warnings:?}");
    // a group given in the file removes the warning
    let (_, warnings) = categories::set_entry(Some("[group]\nhobby = \"play\"\n"), "foo.exe", "hobby").unwrap();
    assert!(warnings.is_empty());
}

// ---- the retired config.toml [categories] table ----

#[test]
fn a_legacy_categories_table_in_config_is_a_one_line_error_not_silently_ignored() {
    let cfg = Config::parse("[categories]\n\"foo.exe\" = \"editor\"\n").unwrap();
    let e = cfg.reject_legacy_categories().unwrap_err();
    assert_eq!(
        e,
        "config.toml has a [categories] table; move it to categories.toml (run: rhen-watch categories init --from-config)"
    );
    assert!(!e.contains('\n'));
    assert!(Config::parse("").unwrap().reject_legacy_categories().is_ok());
    assert!(Config::parse(config::TEMPLATE).unwrap().reject_legacy_categories().is_ok());
}

#[test]
fn from_config_prints_the_migrated_exe_text_and_changes_nothing() {
    let text =
        categories::migrate_from_config("idle_threshold_secs = 90\n[categories]\n\"Foo.exe\" = \"editor\"\n\"bar.exe\" = \"media\"\n")
            .unwrap();
    assert!(text.starts_with("[exe]"), "{text}");
    let f = CategoryFile::parse(&text).unwrap();
    assert_eq!((f.exe["foo.exe"].as_str(), f.exe["bar.exe"].as_str()), ("editor", "media"));
    assert!(
        categories::migrate_from_config("idle_threshold_secs = 90\n")
            .unwrap_err()
            .contains("no [categories]")
    );
}

// ---- config show / set ----

#[test]
fn derive_defaults_and_bounds() {
    let c = Config::parse("").unwrap();
    assert_eq!(
        (
            c.derive.session_gap_minutes,
            c.derive.min_block_minutes,
            c.derive.detour_minutes,
            c.derive.detour_share_percent,
            c.derive.engaged_input_seconds
        ),
        (5, 10, 2, 25, 10)
    );
    assert_eq!(c.retention.input_buckets.days().unwrap(), None);
    for bad in [
        "[derive]\nsession_gap_minutes = 0\n",
        "[derive]\nmin_block_minutes = 0\n",
        "[derive]\ndetour_minutes = 0\n",
        "[derive]\ndetour_share_percent = 0\n",
        "[derive]\ndetour_share_percent = 101\n",
        "[derive]\nengaged_input_seconds = 0\n",
        "[derive]\nengaged_input_seconds = 61\n",
        "[derive]\nmin_block_minutes = 3\ndetour_minutes = 4\n",
        "[derive]\nunknown_knob = 1\n",
        "[retention]\ninput_buckets = 0\n",
    ] {
        assert!(Config::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn shipped_template_shows_every_key_at_its_default() {
    let c = Config::parse(config::TEMPLATE).unwrap();
    assert!(c.entries().iter().all(|e| e.is_default), "{:?}", c.entries());
    assert!(
        !config::TEMPLATE.contains("[categories]"),
        "the template no longer carries the retired table"
    );
    assert!(config::TEMPLATE.contains("[derive]") && config::TEMPLATE.contains("categories.toml"));
}

#[test]
fn config_show_lists_every_key_and_marks_defaults() {
    let c = Config::parse("idle_threshold_secs = 180\n[derive]\nsession_gap_minutes = 8\n[retention]\nevents = 400\n").unwrap();
    let shown = config::show(&c);
    for key in [
        "idle_threshold_secs",
        "extra_games",
        "collectors.foreground",
        "collectors.idle",
        "collectors.session",
        "collectors.power",
        "collectors.title",
        "collectors.ocr",
        "retention.events",
        "retention.metrics",
        "retention.input_buckets",
        "derive.session_gap_minutes",
        "derive.min_block_minutes",
        "derive.detour_minutes",
        "derive.detour_share_percent",
        "derive.engaged_input_seconds",
    ] {
        assert!(shown.contains(key), "{key} missing:\n{shown}");
    }
    let line = |key: &str| shown.lines().find(|l| l.starts_with(key)).unwrap().to_string();
    assert!(line("idle_threshold_secs").contains("180") && !line("idle_threshold_secs").contains("(default)"));
    assert!(line("derive.session_gap_minutes").contains('8') && !line("derive.session_gap_minutes").contains("(default)"));
    assert!(line("derive.min_block_minutes").contains("(default)"));
    assert!(line("retention.events").contains("400") && !line("retention.events").contains("(default)"));
    assert!(line("retention.metrics").contains("permanent") && line("retention.metrics").contains("(default)"));
}

#[test]
fn config_set_accepts_valid_values_and_keeps_comments_and_layout() {
    let out = config::set_key(config::TEMPLATE, "derive.session_gap_minutes", "8").unwrap();
    assert!(Config::parse(&out).unwrap().derive.session_gap_minutes == 8);
    let out = config::set_key(&out, "idle_threshold_secs", "180").unwrap();
    let out = config::set_key(&out, "retention.events", "400").unwrap();
    let out = config::set_key(&out, "retention.metrics", "permanent").unwrap();
    let out = config::set_key(&out, "collectors.power", "false").unwrap();
    let out = config::set_key(&out, "extra_games", "a.exe, B.exe").unwrap();
    let c = Config::parse(&out).unwrap();
    assert_eq!(c.idle_threshold_secs, Some(180));
    assert_eq!(c.retention.events.days().unwrap(), Some(400));
    assert!(!c.collectors.power);
    assert_eq!(c.extra_games, ["a.exe", "b.exe"]);
    // every comment of the template survives
    for comment in config::TEMPLATE.lines().filter(|l| l.trim_start().starts_with('#')) {
        assert!(out.contains(comment), "lost: {comment}");
    }
    // and so do the trailing comments on the lines that changed
    assert!(out.contains("# lock, unlock, logon, logoff, remote sessions"), "{out}");
    let toggled = config::set_key(config::TEMPLATE, "collectors.foreground", "false").unwrap();
    assert!(
        toggled.contains("foreground = false") && toggled.contains("# which app is in front"),
        "{toggled}"
    );
}

#[test]
fn config_set_into_a_missing_table_creates_it() {
    let out = config::set_key("idle_threshold_secs = 120\n", "derive.engaged_input_seconds", "20").unwrap();
    assert_eq!(Config::parse(&out).unwrap().derive.engaged_input_seconds, 20);
}

#[test]
fn config_set_rejects_bad_input_naming_the_key_and_the_range() {
    for (key, value, needle) in [
        ("derive.session_gap_minutes", "0", "derive.session_gap_minutes"),
        ("derive.engaged_input_seconds", "61", "between 1 and 60"),
        ("derive.detour_share_percent", "101", "between 1 and 100"),
        ("derive.detour_minutes", "50", "derive.min_block_minutes"),
        ("derive.session_gap_minutes", "many", "whole number"),
        ("idle_threshold_secs", "0", "idle_threshold_secs"),
        ("retention.events", "0", "retention.events"),
        ("retention.events", "forever", "retention.events"),
        ("collectors.idle", "maybe", "true or false"),
        ("collectors.title", "true", "not built yet"),
        ("collectors.ocr", "true", "not built yet"),
        ("no.such_key", "1", "unknown key"),
        ("derive.typo", "1", "unknown key"),
    ] {
        let before = config::TEMPLATE.to_string();
        let e = config::set_key(&before, key, value).unwrap_err();
        assert!(e.contains(needle), "{key}={value}: {e}");
        assert!(e.contains(key), "the line names the key: {e}");
        assert!(!e.contains('\n'), "one line: {e}");
    }
    // the still-unbuilt collectors can be set to false
    assert!(config::set_key(config::TEMPLATE, "collectors.title", "false").is_ok());
}

#[test]
fn config_set_on_a_file_that_does_not_exist_starts_from_the_template() {
    let dir = std::env::temp_dir().join(format!("rhen-watch-cfg-set-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("config.toml");
    let _ = std::fs::remove_file(&path);
    let note = config::set_and_write(&path, "idle_threshold_secs", "180").unwrap();
    assert!(note.contains("restarts"), "keys the agent reads at start say so: {note}");
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(Config::parse(&text).unwrap().idle_threshold_secs, Some(180));
    assert!(text.contains("# Seconds without keyboard"));
    // a derive key applies to the next report
    let note = config::set_and_write(&path, "derive.session_gap_minutes", "7").unwrap();
    assert!(note.contains("next report"), "{note}");
    // a failure leaves the file untouched
    let before = std::fs::read_to_string(&path).unwrap();
    assert!(config::set_and_write(&path, "derive.session_gap_minutes", "0").is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    assert!(!dir.join("config.toml.tmp").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- tray ----

#[test]
fn tray_command_ids_map_to_actions() {
    assert_eq!(action_for(crate::tray::ID_TOGGLE), TrayAction::TogglePause);
    assert_eq!(action_for(crate::tray::ID_FOLDER), TrayAction::OpenDataFolder);
    assert_eq!(
        action_for(crate::tray::ID_SETTINGS),
        TrayAction::OpenDataFolder,
        "settings live in the data folder"
    );
    assert_eq!(action_for(crate::tray::ID_QUIT), TrayAction::Quit);
    assert_eq!(
        action_for(crate::tray::ID_STATUS),
        TrayAction::None,
        "the status line is not a command"
    );
    assert_eq!(action_for(0), TrayAction::None, "dismissing the menu does nothing");
    assert_eq!(action_for(999), TrayAction::None);
}

#[test]
fn uncategorised_lists_unmapped_exes_by_time_in_front() {
    let c = default_catalogue();
    let totals: Vec<(String, i64)> = vec![
        ("code.exe".into(), 9_000_000),
        ("foo.exe".into(), 60_000),
        ("bar.exe".into(), 120_000),
        ("".into(), 5_000_000),
        ("baz.exe".into(), 120_000),
    ];
    let u = categories::uncategorised(&totals, &c, 2);
    assert_eq!(u, vec![("bar.exe".to_string(), 120_000), ("baz.exe".to_string(), 120_000)]);
    assert_eq!(categories::paste_line("foo.exe"), "\"foo.exe\" = \"...\"");
    let file = CategoryFile::parse("[exe]\n\"foo.exe\" = \"editor\"\n").unwrap();
    let c = Catalogue::with_file(&file, &[]);
    assert!(
        categories::uncategorised(&totals, &c, 15).iter().all(|(e, _)| e != "foo.exe"),
        "labelling removes it from the list"
    );
}

#[test]
fn the_old_config_init_template_with_an_empty_categories_table_still_loads() {
    // `config init` used to write a [categories] table holding only a commented example.
    let old = "idle_threshold_secs = 120\nextra_games = []\n\n[collectors]\nforeground = true\n\n[retention]\nevents = \"permanent\"\nmetrics = \"permanent\"\n\n# exe file name -> category. Overrides the built-in table.\n[categories]\n# \"mything.exe\" = \"editor\"\n";
    let cfg = Config::parse(old).unwrap();
    assert!(cfg.reject_legacy_categories().is_ok(), "an empty table holds nothing to move");
    assert!(
        Config::parse("[categories]\n\"a.exe\" = \"editor\"\n")
            .unwrap()
            .reject_legacy_categories()
            .is_err()
    );
}

#[test]
fn config_set_on_a_file_where_a_table_is_a_plain_value_is_an_error_not_a_panic() {
    for text in ["derive = 5\n", "retention = \"x\"\n", "collectors = [1]\n"] {
        for key in ["derive.min_block_minutes", "retention.events", "collectors.idle"] {
            let r = std::panic::catch_unwind(|| config::set_key(text, key, "1"));
            let r = r.unwrap_or_else(|_| panic!("set_key panicked on {text:?} / {key}"));
            if let Err(e) = r {
                assert!(!e.contains('\n'), "{e}");
            }
        }
    }
    let e = config::set_key("derive = 5\n", "derive.min_block_minutes", "12").unwrap_err();
    assert!(e.contains("derive.min_block_minutes") && e.contains("table"), "{e}");
}

#[test]
fn idle_threshold_is_bounded_so_milliseconds_cannot_overflow() {
    assert!(Config::parse("idle_threshold_secs = 86400\n").is_ok());
    assert!(Config::parse("idle_threshold_secs = 86401\n").is_err());
    assert!(Config::parse("idle_threshold_secs = 9223372036854775807\n").is_err());
    let e = config::set_key(config::TEMPLATE, "idle_threshold_secs", "99999999999").unwrap_err();
    assert!(e.contains("idle_threshold_secs") && e.contains("86400"), "{e}");
}

#[test]
fn case_variant_duplicate_exe_keys_are_an_error_not_a_silent_merge() {
    let e = CategoryFile::parse("[exe]\n\"Foo.exe\" = \"editor\"\n\"foo.exe\" = \"media\"\n").unwrap_err();
    assert!(e.contains("foo.exe") && e.contains("twice"), "{e}");
}

#[test]
fn utf16_without_a_bom_is_detected_in_either_byte_order() {
    let le: Vec<u8> = "[exe]\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let be: Vec<u8> = "[exe]\n".encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
    assert!(config::decode_text(&le, "config.toml").unwrap_err().contains("UTF-8"));
    assert!(config::decode_text(&be, "config.toml").unwrap_err().contains("UTF-8"));
}

// ---- cleanup batch: config set / categories rough edges ----

fn temp_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("rhen-watch-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn a_problem_elsewhere_in_the_file_is_not_blamed_on_the_key_being_set() {
    let text = "idle_threshold_secs = \"x\"\n";
    let e = config::set_key(text, "derive.detour_minutes", "1").unwrap_err();
    assert!(e.starts_with("config.toml already has a problem:"), "{e}");
    assert!(
        e.contains("line 1, column") && e.contains("fix it first"),
        "the position is kept: {e}"
    );
    assert!(!e.contains("derive.detour_minutes"), "{e}");
    let e = config::set_key("[collectors]\nfoo = 1\n", "collectors.idle", "false").unwrap_err();
    assert!(e.contains("already has a problem") && e.contains("foo"), "{e}");
}

#[test]
fn a_set_that_repairs_a_bad_file_still_works_and_a_bad_value_still_names_its_key() {
    // The file breaks a rule; the set fixes it, so it must be allowed.
    let bad = "idle_threshold_secs = 0\n";
    assert!(config::set_key(bad, "idle_threshold_secs", "60").is_ok());
    let e = config::set_key(config::TEMPLATE, "derive.min_block_minutes", "1").unwrap_err();
    assert!(e.starts_with("derive.min_block_minutes"), "{e}");
    assert!(e.contains("(1)") && e.contains("(2)"), "the values are in the message: {e}");
}

#[test]
fn config_set_warns_when_a_leftover_categories_table_will_stop_the_agent() {
    let dir = temp_dir("legacy-set");
    let path = dir.join("config.toml");
    std::fs::write(&path, "[categories]\n\"foo.exe\" = \"editor\"\n").unwrap();
    let note = config::set_and_write(&path, "idle_threshold_secs", "180").unwrap();
    assert!(
        note.contains("will not start") && note.contains("categories init --from-config"),
        "{note}"
    );
    let e = config::show_file(&path).unwrap_err();
    assert!(e.contains("[categories]"), "show refuses it as run does: {e}");
    let clean = dir.join("clean.toml");
    let note = config::set_and_write(&clean, "idle_threshold_secs", "180").unwrap();
    assert_eq!(note, "idle_threshold_secs set; takes effect when the agent restarts");
    assert!(config::show_file(&clean).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn atomic_writes_replace_the_file_and_leave_no_temp_file() {
    let dir = temp_dir("atomic");
    let path = dir.join("config.toml");
    config::write_atomic(&path, "a = 1\n").unwrap();
    config::write_atomic(&path, "a = 2\n").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "a = 2\n");
    assert!(!dir.join("config.toml.tmp").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn categories_set_changes_a_hand_written_mixed_case_key_in_place() {
    let existing = "[exe]\n# my editor\n\"Code.exe\" = \"editor\"\n";
    let (out, _) = categories::set_entry(Some(existing), "code.exe", "notes").unwrap();
    assert!(out.contains("# my editor"), "{out}");
    assert_eq!(CategoryFile::parse(&out).unwrap().exe["code.exe"], "notes");
    assert_eq!(out.matches(".exe").count(), 1, "no second entry: {out}");
}

#[test]
fn an_unquoted_exe_name_gets_a_message_that_says_to_quote_it() {
    let e = CategoryFile::parse("[exe]\nnotepad.exe = \"editor\"\n").unwrap_err();
    assert!(e.contains("put the exe name in quotes") && e.contains("\"notepad.exe\""), "{e}");
}

#[test]
fn category_names_are_not_case_sensitive() {
    let f = CategoryFile::parse("[exe]\n\"foo.exe\" = \"Editor\"\n[group]\nMine = \"work\"\n").unwrap();
    assert_eq!(f.exe["foo.exe"], "editor");
    assert_eq!(f.group["mine"], "work");
    let (out, _) = categories::set_entry(None, "foo.exe", "Editor").unwrap();
    assert!(out.contains("\"editor\""), "{out}");
}

#[test]
fn retention_errors_say_what_is_allowed() {
    for bad in [
        "events = -3",
        "events = true",
        "events = 1.5",
        "events = { days = 3 }",
        "events = [3]",
        "events = \"forever\"",
    ] {
        let e = Config::parse(&format!("[retention]\n{bad}\n")).unwrap_err();
        assert!(e.contains("\"permanent\" or a number of days"), "{bad}: {e}");
    }
    let zero = Config::parse("[retention]\nevents = 0\n").unwrap_err();
    assert!(zero.contains("would delete everything"), "{zero}");
    assert!(Config::parse("[retention]\nevents = 30\nmetrics = \"permanent\"\n").is_ok());
}

#[test]
fn idle_needs_the_foreground_collector() {
    let c = Config::parse("[collectors]\nforeground = false\n").unwrap();
    assert!(!c.idle_enabled(), "no way to spot a game, so no idle sampling");
    assert!(Config::default().idle_enabled());
    assert!(!Config::parse("[collectors]\nidle = false\n").unwrap().idle_enabled());
}

// ---- run lock and stop event ----

#[test]
fn a_probe_does_not_make_the_agent_look_running_or_block_it_for_long() {
    use std::time::Duration;
    let dir = temp_dir("lock");
    let lock_path = dir.join("run.lock");
    let open = || {
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap()
    };
    assert!(!crate::cli::agent_running(&dir));
    // Another probe holding the file is not an agent.
    let other_probe = open();
    other_probe.try_lock_shared().unwrap();
    assert!(
        !crate::cli::agent_running(&dir),
        "two probes at once must not report a running agent"
    );
    drop(other_probe);
    // A real agent is seen.
    let agent = open();
    agent.try_lock().unwrap();
    assert!(crate::cli::agent_running(&dir));
    drop(agent);
    // A lock held for a moment is waited out; one held for good is refused.
    let blocker = open();
    blocker.try_lock().unwrap();
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        drop(blocker);
    });
    let mine = open();
    crate::cli::lock_with_retry(&mine, 10, Duration::from_millis(100)).expect("waits for the brief holder");
    releaser.join().unwrap();
    let second = open();
    let e = crate::cli::lock_with_retry(&second, 3, Duration::from_millis(10)).unwrap_err();
    assert!(e.contains("already running"), "{e}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_stop_event_is_per_data_directory() {
    let a = temp_dir("stop-a");
    let b = temp_dir("stop-b");
    let na = crate::paths::stop_event_name(&a);
    assert_eq!(na, crate::paths::stop_event_name(&a), "stable for one directory");
    assert_ne!(na, crate::paths::stop_event_name(&b), "a test directory has its own event");
    assert!(na.starts_with("Local\\rhen-watch-stop-"), "{na}");
    assert_eq!(
        na,
        crate::paths::stop_event_name(&a.join("..").join(a.file_name().unwrap())),
        "the canonical path is hashed"
    );
    let _ = std::fs::remove_dir_all(&a);
    let _ = std::fs::remove_dir_all(&b);
}

#[test]
fn stop_also_tries_the_pre_hash_event_name_so_an_upgrade_can_stop_the_old_agent() {
    let d = temp_dir("stop-legacy");
    let names = crate::paths::stop_event_names(&d);
    assert_eq!(names[0], crate::paths::stop_event_name(&d));
    assert_eq!(names[1], "Local\\rhen-watch-stop");
    assert_ne!(names[0], names[1]);
    let _ = std::fs::remove_dir_all(&d);
}
