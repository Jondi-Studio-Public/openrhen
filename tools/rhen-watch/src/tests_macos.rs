//! The macOS layer's pure rules, tested on any OS.

use crate::categories::{Catalogue, is_shell_window, normalise_exe};
use crate::engine::PowerEvt;
use crate::platform::macos_rules::{PowerDedupe, identity, is_agent_path, pid_from_lock, power_source};

#[test]
fn identity_prefers_the_bundle_id_lower_cased() {
    assert_eq!(
        identity(
            Some("com.Microsoft.VSCode"),
            Some("/Applications/Visual Studio Code.app/Contents/MacOS/Electron")
        )
        .as_deref(),
        Some("com.microsoft.vscode")
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
    assert!(!is_agent_path("/Applications/Safari.app/Contents/MacOS/Safari"));
    assert!(!is_agent_path("/usr/bin/rhen-watch-other"));
}

#[test]
fn bundle_ids_are_valid_category_keys_and_exe_rules_still_hold() {
    assert_eq!(normalise_exe("Com.Example.App").unwrap(), "com.example.app");
    assert_eq!(normalise_exe("chrome.exe").unwrap(), "chrome.exe");
    assert!(normalise_exe("chrome").is_err());
    assert!(normalise_exe(".exe").is_err());
    assert!(normalise_exe("com..app").is_err());
    assert!(normalise_exe("com.example/app").is_err());
    assert!(normalise_exe("com.example app").is_err());
}

#[test]
fn macos_apps_have_categories_and_system_ui_does_not_end_an_interval() {
    let c = Catalogue::new(&Default::default(), &[]);
    assert_eq!(c.category("com.google.chrome"), "browser");
    assert_eq!(c.category("com.microsoft.vscode"), "editor");
    assert!(is_shell_window("", Some("com.apple.loginwindow")));
    assert!(is_shell_window("", Some("com.apple.dock")));
    assert!(!is_shell_window("", Some("com.apple.finder")));
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
