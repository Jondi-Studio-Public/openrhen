//! Executable name -> category, the executable denylist and the shell-window ignore list.
//!
//! Every app Jondi uses is Electron or Chromium, so the window class is always `Chrome_WidgetWin_1`; the
//! executable name is the identity and the category comes from this table, which the config can extend.

use std::collections::HashMap;

/// Window classes of the shell that must not end the real app's interval (taskbar, tray overflow, task switcher).
pub const SHELL_CLASSES: &[&str] = &[
    "shell_traywnd",
    "shell_secondarytraywnd",
    "notifyiconoverflowwindow",
    "xamlexplorerhostislandwindow",
    "taskswitcherwnd",
    "taskswitcheroverlaywnd",
    "foregroundstaging",
    "multitaskingviewframe",
    "windows.ui.core.corewindow",
    "tooltips_class32",
    "#32768", // a context menu
];

/// Executables (lower case) that protect themselves with kernel anti-cheat. While one is in front the agent
/// records only that it is suppressed, and does no other work.
pub const DEFAULT_GAMES: &[&str] = &[
    "valorant.exe",
    "valorant-win64-shipping.exe",
    "vgc.exe",
    "riotclientservices.exe",
    "league of legends.exe",
    "fortniteclient-win64-shipping.exe",
    "easyanticheat.exe",
    "battleye.exe",
    "r5apex.exe",
    "r5apex_dx12.exe",
    "escapefromtarkov.exe",
    "destiny2.exe",
    "rainbowsix.exe",
    "rainbowsix_vulkan.exe",
    "cs2.exe",
    "csgo.exe",
    "dota2.exe",
    "overwatch.exe",
    "tslgame.exe",
    "rustclient.exe",
    "eldenring.exe",
    "gta5.exe",
    "gtav.exe",
    "cod.exe",
    "modernwarfare.exe",
    "bf2042.exe",
    "thefinals.exe",
    "tarkov.exe",
    "dayz_x64.exe",
    "apexlegends.exe",
];

const DEFAULT_CATEGORIES: &[(&str, &str)] = &[
    ("chrome.exe", "browser"),
    ("msedge.exe", "browser"),
    ("firefox.exe", "browser"),
    ("brave.exe", "browser"),
    ("opera.exe", "browser"),
    ("vivaldi.exe", "browser"),
    ("arc.exe", "browser"),
    ("code.exe", "editor"),
    ("cursor.exe", "editor"),
    ("windsurf.exe", "editor"),
    ("devenv.exe", "editor"),
    ("idea64.exe", "editor"),
    ("pycharm64.exe", "editor"),
    ("webstorm64.exe", "editor"),
    ("rustrover64.exe", "editor"),
    ("notepad.exe", "editor"),
    ("notepad++.exe", "editor"),
    ("sublime_text.exe", "editor"),
    ("obsidian.exe", "notes"),
    ("notion.exe", "notes"),
    ("onenote.exe", "notes"),
    ("claude.exe", "assistant"),
    ("chatgpt.exe", "assistant"),
    ("discord.exe", "chat"),
    ("slack.exe", "chat"),
    ("teams.exe", "chat"),
    ("ms-teams.exe", "chat"),
    ("whatsapp.exe", "chat"),
    ("telegram.exe", "chat"),
    ("signal.exe", "chat"),
    ("zoom.exe", "meeting"),
    ("outlook.exe", "mail"),
    ("olk.exe", "mail"),
    ("thunderbird.exe", "mail"),
    ("spotify.exe", "media"),
    ("vlc.exe", "media"),
    ("wmplayer.exe", "media"),
    ("windowsterminal.exe", "terminal"),
    ("wt.exe", "terminal"),
    ("powershell.exe", "terminal"),
    ("pwsh.exe", "terminal"),
    ("cmd.exe", "terminal"),
    ("conhost.exe", "terminal"),
    ("explorer.exe", "files"),
    ("winword.exe", "office"),
    ("excel.exe", "office"),
    ("powerpnt.exe", "office"),
    ("steam.exe", "games"),
    ("epicgameslauncher.exe", "games"),
    ("t3 code.exe", "editor"),
    ("t3code.exe", "editor"),
];

#[derive(Debug, Clone)]
pub struct Catalogue {
    categories: HashMap<String, String>,
    games: Vec<String>,
}

impl Catalogue {
    pub fn new(extra_categories: &HashMap<String, String>, extra_games: &[String]) -> Self {
        let mut categories: HashMap<String, String> = DEFAULT_CATEGORIES.iter().map(|(e, c)| (e.to_string(), c.to_string())).collect();
        for (exe, category) in extra_categories {
            categories.insert(exe.to_ascii_lowercase(), category.clone());
        }
        let mut games: Vec<String> = DEFAULT_GAMES.iter().map(|g| g.to_string()).collect();
        games.extend(extra_games.iter().map(|g| g.to_ascii_lowercase()));
        Self { categories, games }
    }

    pub fn category(&self, exe: &str) -> &str {
        self.categories.get(exe).map(String::as_str).unwrap_or("other")
    }

    pub fn is_game(&self, exe: &str) -> bool {
        self.games.iter().any(|g| g == exe)
    }
}

pub fn is_shell_class(class: &str) -> bool {
    let lower = class.to_ascii_lowercase();
    SHELL_CLASSES.contains(&lower.as_str())
}
