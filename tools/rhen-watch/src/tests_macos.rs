//! The macOS layer's pure rules, tested on any OS.

use crate::categories::{Catalogue, is_shell_window, normalise_exe};
use crate::engine::PowerEvt;
use crate::platform::macos_rules::{PowerDedupe, SHELL_BUNDLES, identity, is_agent_path, pid_from_lock, power_source};

#[test]
fn identity_prefers_the_bundle_id_lower_cased() {
    assert_eq!(
        identity(
            Some("com.Example.Editor"),
            Some("/Applications/Visual Studio Code.app/Contents/MacOS/Electron")
        )
        .as_deref(),
        Some("com.example.editor")
    );
}

#[test]
fn identity_falls_back_to_the_executable_name() {
    assert_eq!(identity(None, Some("/usr/local/bin/SomeTool")).as_deref(), Some("sometool"));
    assert_eq!(identity(Some("  "), Some("/opt/x/tool/")).as_deref(), Some("tool"));
}

#[test]
fn identity_is_none_when_the_os_gave_nothing() {
    assert_eq!(identity(None, None), None);
    assert_eq!(identity(Some(""), Some("")), None);
    assert_eq!(identity(None, Some("/")), None);
}

#[test]
fn power_source_names_map_and_unknown_is_nothing() {
    assert_eq!(power_source("AC Power"), Some(PowerEvt::Ac));
    assert_eq!(power_source("Battery Power"), Some(PowerEvt::Battery));
    assert_eq!(power_source("UPS Power"), Some(PowerEvt::Battery));
    assert_eq!(power_source("Off Line"), None);
}

#[test]
fn power_dedupe_passes_only_a_change_of_source() {
    let mut d = PowerDedupe::new();
    assert_eq!(d.changed(Some(PowerEvt::Ac)), Some(PowerEvt::Ac));
    assert_eq!(d.changed(Some(PowerEvt::Ac)), None);
    assert_eq!(d.changed(None), None);
    assert_eq!(d.changed(Some(PowerEvt::Battery)), Some(PowerEvt::Battery));
    assert_eq!(d.changed(Some(PowerEvt::Ac)), Some(PowerEvt::Ac));
}

#[test]
fn pid_from_lock_reads_only_a_real_pid() {
    assert_eq!(pid_from_lock("4242\n"), Some(4242));
    assert_eq!(pid_from_lock(""), None);
    assert_eq!(pid_from_lock("1"), None, "never signal launchd");
    assert_eq!(pid_from_lock("0"), None);
    assert_eq!(pid_from_lock("-5"), None);
    assert_eq!(pid_from_lock("abc"), None);
}

#[test]
fn stop_only_signals_a_rhen_watch_binary() {
    assert!(is_agent_path("/Users/a/Applications/rhen-watch.app/Contents/MacOS/rhen-watch"));
    assert!(is_agent_path("/tmp/target/release/rhen-watch"));
    assert!(!is_agent_path("/Applications/Browser.app/Contents/MacOS/Browser"));
    assert!(!is_agent_path("/usr/bin/rhen-watch-other"));
}

#[test]
fn bundle_ids_are_valid_category_keys_and_exe_rules_still_hold() {
    assert_eq!(normalise_exe("Com.Example.App").unwrap(), "com.example.app");
    assert_eq!(normalise_exe("editor.exe").unwrap(), "editor.exe");
    assert!(normalise_exe("editor").is_err());
    assert!(normalise_exe(".exe").is_err());
    assert!(normalise_exe("com..app").is_err());
    assert!(normalise_exe("com.example/app").is_err());
    assert!(normalise_exe("com.example app").is_err());
}

#[test]
fn system_ui_does_not_end_an_interval() {
    assert!(SHELL_BUNDLES.iter().all(|b| is_shell_window("", Some(b))));
    assert!(!is_shell_window("", Some("com.example.files")));
}

#[test]
fn an_app_is_categorised_by_what_it_declares() {
    use crate::categories::declared_category;
    assert_eq!(
        declared_category("public.app-category.developer-tools").as_deref(),
        Some("developer-tools")
    );
    assert_eq!(
        declared_category(" Public.App-Category.Productivity ").as_deref(),
        Some("productivity")
    );
    assert_eq!(declared_category("public.app-category.games").as_deref(), Some("games"));
    assert_eq!(declared_category("public.app-category.racing-games").as_deref(), Some("games"));
    assert_eq!(declared_category("com.example.custom"), None);
    assert_eq!(declared_category("public.app-category."), None);
    assert_eq!(declared_category("public.app-category.a b"), None);
    // No starter table for macOS: an app that declares nothing stays uncategorised until the user sets it.
    let c = Catalogue::new(&Default::default(), &[]);
    assert_eq!(c.lookup("com.example.editor"), None);
    // What it declared fills the gap, and the user's own file still wins.
    let mut file = crate::categories::CategoryFile::default();
    file.exe.insert("com.example.notes".into(), "notes".into());
    let c = Catalogue::with_file(&file, &[]).with_declared([
        ("com.example.editor".to_string(), "public.app-category.developer-tools".to_string()),
        ("com.example.notes".to_string(), "public.app-category.productivity".to_string()),
        ("com.example.odd".to_string(), "not-a-category".to_string()),
    ]);
    assert_eq!(c.category("com.example.editor"), "developer-tools");
    assert_eq!(c.group_of_exe("com.example.editor"), "work");
    assert_eq!(c.category("com.example.notes"), "notes");
    assert_eq!(c.lookup("com.example.odd"), None);
    let totals = vec![("com.example.editor".to_string(), 10), ("com.example.odd".to_string(), 5)];
    let left = crate::categories::uncategorised(&totals, &c, 10);
    assert_eq!(left, vec![("com.example.odd".to_string(), 5)]);
}

#[test]
fn the_engine_records_the_declared_category_and_keeps_the_raw_type() {
    use crate::engine::{Engine, Fg, Settings, Signal};
    use crate::model::Op;
    let mut e = Engine::new(
        Settings::default(),
        Catalogue::new(&Default::default(), &[]),
        Box::new(|| "id".to_string()),
    );
    let step = e.step(
        1000,
        Signal::Foreground(Fg {
            class: String::new(),
            exe: Some("com.example.editor".into()),
            declared: Some("public.app-category.developer-tools".into()),
        }),
    );
    let attrs = step
        .ops
        .iter()
        .find_map(|o| match o {
            Op::Open { kind, attrs, .. } if kind == "app" => Some(attrs.clone()),
            _ => None,
        })
        .expect("an app interval");
    assert_eq!(attrs["category"], "developer-tools");
    assert_eq!(attrs["declared"], "public.app-category.developer-tools");
    // The store hands it back to the report, which re-reads categories at report time.
    let mut store = crate::store::Store::in_memory().unwrap();
    store.apply("d", &step.ops, 1000).unwrap();
    store.apply("d", &[Op::Close { id: "id".into(), ts: 5000 }], 5000).unwrap();
    assert_eq!(
        store.declared_apps().unwrap(),
        vec![("com.example.editor".to_string(), "public.app-category.developer-tools".to_string())]
    );
}

#[test]
fn every_shipped_category_key_is_valid() {
    for (exe, _) in crate::categories::DEFAULT_CATEGORIES {
        assert_eq!(normalise_exe(exe).as_deref(), Ok(*exe), "{exe}");
    }
}

#[test]
fn launch_agent_restarts_only_after_a_crash_and_escapes_paths() {
    use crate::platform::macos_rules::{LABEL, launch_agent_plist};
    let p = launch_agent_plist(
        "/Users/a b/Applications/rhen-watch.app/Contents/MacOS/rhen-watch",
        "/Users/a b/data&x",
        "/Users/a b",
    );
    assert!(p.contains(&format!("<string>{LABEL}</string>")));
    assert!(p.contains("<key>SuccessfulExit</key><false/>"));
    assert!(p.contains("<string>Aqua</string>"));
    assert!(p.contains("<string>run</string>"));
    assert!(p.contains("/Users/a b/data&amp;x/launchd.log"));
    assert!(p.contains("<key>RHEN_WATCH_DIR</key><string>/Users/a b/data&amp;x</string>"));
    assert!(!p.contains("data&x"));
}

#[test]
fn info_plist_is_a_menu_bar_app() {
    let p = crate::platform::macos_rules::info_plist("0.1.0");
    assert!(p.contains("<key>LSUIElement</key><true/>"));
    assert!(p.contains("<string>13.0</string>"));
    assert!(p.contains("<string>0.1.0</string>"));
}

mod path_link {
    use crate::platform::macos_rules::{add_path_block, path_has, profile_for_shell, remove_path_block};

    #[test]
    fn path_has_matches_whole_entries_only() {
        assert!(path_has("/usr/bin:/Users/a/.local/bin:/bin", "/Users/a/.local/bin"));
        assert!(path_has("/Users/a/.local/bin/", "/Users/a/.local/bin"));
        assert!(!path_has("/Users/a/.local/bin2:/bin", "/Users/a/.local/bin"));
        assert!(!path_has("", "/Users/a/.local/bin"));
    }

    #[test]
    fn profile_follows_the_login_shell() {
        assert_eq!(profile_for_shell(Some("/bin/zsh")), Some(".zprofile"));
        assert_eq!(profile_for_shell(None), Some(".zprofile"));
        assert_eq!(profile_for_shell(Some("/opt/homebrew/bin/bash")), Some(".bash_profile"));
        assert_eq!(profile_for_shell(Some("/opt/homebrew/bin/fish")), None);
    }

    #[test]
    fn the_block_is_added_once_and_removed_cleanly() {
        let before = "# conda\nexport FOO=1";
        let added = add_path_block(before).unwrap();
        assert!(added.starts_with("# conda\nexport FOO=1\n# >>> rhen-watch"));
        assert!(added.contains("export PATH=\"$HOME/.local/bin:$PATH\"\n"));
        assert_eq!(add_path_block(&added), None);
        let mut later = added.clone();
        later.push_str("alias ll='ls -l'\n");
        assert_eq!(remove_path_block(&later).unwrap(), "# conda\nexport FOO=1\nalias ll='ls -l'\n");
        assert_eq!(remove_path_block(before), None);
        assert_eq!(add_path_block("").unwrap().lines().count(), 3);
    }

    #[test]
    fn a_block_with_no_end_line_is_left_alone() {
        let broken = "# >>> rhen-watch: add ~/.local/bin to PATH >>>\nexport PATH=x\nalias keep=me\n";
        assert_eq!(remove_path_block(broken), None);
    }
}
