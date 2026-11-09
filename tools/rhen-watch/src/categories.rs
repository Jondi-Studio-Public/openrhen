//! Executable name -> category, the executable denylist and the shell-window ignore list.
//!
//! Many desktop apps are Electron or Chromium and share the window class `Chrome_WidgetWin_1`, so the
//! executable name is the identity and the category comes from this table. The shipped defaults are compiled
//! in; `categories.toml` (beside `config.toml`) holds overrides, `[exe]` for exe -> category and `[group]` for
//! category -> group. That file is the only home for overrides.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use serde::Deserialize;

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

pub const DEFAULT_CATEGORIES: &[(&str, &str)] = &[
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

/// The coarser groups, used only to derive input stretches. A browser is its own group: what it is used for
/// cannot be told from the exe name.
pub const GROUPS: &[&str] = &["work", "browser", "comms", "media", "play", "other"];

/// category -> group for every shipped category.
pub const DEFAULT_GROUPS: &[(&str, &str)] = &[
    ("editor", "work"),
    ("terminal", "work"),
    ("notes", "work"),
    ("assistant", "work"),
    ("office", "work"),
    ("files", "work"),
    ("browser", "browser"),
    ("chat", "comms"),
    ("mail", "comms"),
    ("meeting", "comms"),
    ("media", "media"),
    ("games", "play"),
    // The categories macOS apps declare for themselves (see `declared_category`).
    ("developer-tools", "work"),
    ("productivity", "work"),
    ("business", "work"),
    ("graphics-design", "work"),
    ("reference", "work"),
    ("education", "work"),
    ("finance", "work"),
    ("utilities", "work"),
    ("social-networking", "comms"),
    ("music", "media"),
    ("video", "media"),
    ("entertainment", "media"),
    ("photography", "media"),
    ("other", "other"),
];

/// The category an app declares for itself, from its OS-defined type (macOS `LSApplicationCategoryType`, for
/// example `public.app-category.developer-tools`): the part after the prefix, and every kind of game is
/// `games`. `None` for anything else. The user's `categories.toml` still wins over it.
pub fn declared_category(declared: &str) -> Option<String> {
    let name = declared.trim().to_ascii_lowercase();
    let name = name.strip_prefix("public.app-category.")?;
    if name == "games" || name.ends_with("-games") {
        return Some("games".to_string());
    }
    valid_word(name).then(|| name.to_string())
}

/// The contents of `categories.toml`: overrides on top of the compiled defaults. A missing file is valid.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CategoryFile {
    /// exe file name (lower case) -> category
    pub exe: BTreeMap<String, String>,
    /// category -> group
    pub group: BTreeMap<String, String>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RawCategoryFile {
    /// Values are read loosely so an unquoted `notepad.exe = ...` (a dotted key, so a table) gets a useful message.
    exe: BTreeMap<String, toml::Value>,
    group: BTreeMap<String, String>,
}

fn valid_word(w: &str) -> bool {
    !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// An app identity as stored, lower case: a Windows executable file name ending in `.exe`, or a macOS bundle
/// identifier in reverse-DNS form (`com.example.app`), which is what the macOS agent records.
pub fn normalise_exe(exe: &str) -> Result<String, String> {
    let e = exe.trim().to_ascii_lowercase();
    let bad_chars = e.chars().any(|c| c.is_control() || matches!(c, '"' | '\\' | '/' | ':'));
    let windows = e.strip_suffix(".exe").is_some_and(|stem| !stem.is_empty());
    if !bad_chars && (windows || is_bundle_id(&e)) {
        return Ok(e);
    }
    Err(format!(
        "\"{exe}\": an app must be an executable file name ending in .exe, or a macOS bundle id such as com.example.app"
    ))
}

/// Reverse-DNS: at least two dot-separated labels of letters, digits, `-` and `_`.
fn is_bundle_id(id: &str) -> bool {
    let labels: Vec<&str> = id.split('.').collect();
    labels.len() >= 2
        && labels
            .iter()
            .all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}

/// `prefix` plus the chain of single-key tables under it: the name a dotted key was meant to be.
fn dotted_name(mut name: String, mut t: &toml::Table) -> String {
    while let Some((k, v)) = t.iter().next().filter(|_| t.len() == 1) {
        name = format!("{name}.{k}");
        match v {
            toml::Value::Table(next) => t = next,
            _ => break,
        }
    }
    name
}

pub fn validate_category(category: &str) -> Result<(), String> {
    if valid_word(category) {
        Ok(())
    } else {
        Err(format!("category \"{category}\" must be one word of letters, digits, - or _"))
    }
}

impl CategoryFile {
    pub fn parse(text: &str) -> Result<Self, String> {
        let raw: RawCategoryFile = toml::from_str(text).map_err(|e| format!("categories.toml: {e}"))?;
        let mut out = CategoryFile::default();
        for (exe, category) in raw.exe {
            let category = match category {
                toml::Value::String(c) => c,
                toml::Value::Table(t) => {
                    // `notepad.exe = "editor"` reads as table `notepad` holding `exe`: rebuild the name to show.
                    let name = dotted_name(exe.clone(), &t);
                    return Err(format!(
                        "categories.toml: [exe] \"{exe}\" is a table; put the exe name in quotes: \"{name}\" = \"category\""
                    ));
                }
                _ => return Err(format!("categories.toml: [exe] \"{exe}\" must be a category name in quotes")),
            };
            let category = category.to_ascii_lowercase();
            let key = normalise_exe(&exe).map_err(|e| format!("categories.toml: [exe] {e}"))?;
            validate_category(&category).map_err(|e| format!("categories.toml: [exe] \"{exe}\": {e}"))?;
            if out.exe.insert(key.clone(), category).is_some() {
                return Err(format!(
                    "categories.toml: [exe] \"{key}\" is given twice (names are not case sensitive)"
                ));
            }
        }
        for (category, group) in raw.group {
            validate_category(&category).map_err(|e| format!("categories.toml: [group] {e}"))?;
            let category = category.to_ascii_lowercase(); // names are not case sensitive, like exe names
            if !GROUPS.contains(&group.as_str()) {
                return Err(format!(
                    "categories.toml: [group] {category}: \"{group}\" is not a group ({})",
                    GROUPS.join(", ")
                ));
            }
            out.group.insert(category, group);
        }
        Ok(out)
    }

    /// A missing file is the empty override set; a bad one is an error naming the file, line and reason.
    pub fn load(path: &Path) -> Result<Self, String> {
        match crate::config::read_text(path, "categories.toml")? {
            Some(text) => Self::parse(&text).map_err(|e| format!("{}: {e}", path.display())),
            None => Ok(Self::default()),
        }
    }
}

/// For `run`: a bad file must not stop recording (a typo in a cosmetic file cannot open a hole in the day), so
/// it falls back to the compiled defaults and hands back the reason to log and record.
pub fn load_or_default(path: &Path) -> (CategoryFile, Option<String>) {
    match CategoryFile::load(path) {
        Ok(f) => (f, None),
        Err(e) => (CategoryFile::default(), Some(e)),
    }
}

#[derive(Debug, Clone)]
pub struct Catalogue {
    categories: HashMap<String, String>,
    groups: HashMap<String, String>,
    games: Vec<String>,
    /// app -> the category it declared for itself; used only for apps in neither table.
    declared: HashMap<String, String>,
}

impl Catalogue {
    /// Defaults plus exe -> category overrides (no group overrides).
    pub fn new(extra_categories: &HashMap<String, String>, extra_games: &[String]) -> Self {
        let file = CategoryFile {
            exe: extra_categories.iter().map(|(e, c)| (e.to_ascii_lowercase(), c.clone())).collect(),
            group: BTreeMap::new(),
        };
        Self::with_file(&file, extra_games)
    }

    /// Defaults, then the file on top.
    pub fn with_file(file: &CategoryFile, extra_games: &[String]) -> Self {
        let mut categories: HashMap<String, String> = DEFAULT_CATEGORIES.iter().map(|(e, c)| (e.to_string(), c.to_string())).collect();
        for (exe, category) in &file.exe {
            categories.insert(exe.clone(), category.clone());
        }
        let mut groups: HashMap<String, String> = DEFAULT_GROUPS.iter().map(|(c, g)| (c.to_string(), g.to_string())).collect();
        for (category, group) in &file.group {
            groups.insert(category.clone(), group.clone());
        }
        let mut games: Vec<String> = DEFAULT_GAMES.iter().map(|g| g.to_string()).collect();
        games.extend(extra_games.iter().map(|g| g.trim().to_ascii_lowercase()));
        Self {
            categories,
            groups,
            games,
            declared: HashMap::new(),
        }
    }

    /// The category of an exe, or `None` when it is in no table (so the report can list it as not categorised).
    pub fn lookup(&self, exe: &str) -> Option<&str> {
        self.categories.get(exe).or_else(|| self.declared.get(exe)).map(String::as_str)
    }

    /// What is written on a foreground row: the category, `other` for an exe in no table.
    pub fn category(&self, exe: &str) -> &str {
        self.lookup(exe).unwrap_or("other")
    }

    /// Add what apps declared for themselves, as (app, declared type) pairs the store kept.
    pub fn with_declared(mut self, pairs: impl IntoIterator<Item = (String, String)>) -> Self {
        for (exe, declared) in pairs {
            if let Some(category) = declared_category(&declared) {
                self.declared.insert(exe, category);
            }
        }
        self
    }

    /// The group of a category; one with no group counts as `other`.
    pub fn group_of_category(&self, category: &str) -> &str {
        self.groups.get(category).map(String::as_str).unwrap_or("other")
    }

    pub fn group_of_exe(&self, exe: &str) -> &str {
        self.group_of_category(self.category(exe))
    }

    /// Categories in use that have no group (they would count as `other` and never form an input block).
    pub fn groupless(&self) -> Vec<String> {
        let used: BTreeSet<&String> = self.categories.values().collect();
        used.into_iter().filter(|c| !self.groups.contains_key(*c)).cloned().collect()
    }

    pub fn is_game(&self, exe: &str) -> bool {
        self.games.iter().any(|g| g == exe)
    }

    /// Every exe -> category in effect, sorted, with where it came from.
    pub fn entries(&self, file: &CategoryFile) -> Vec<(String, String, &'static str)> {
        let mut v: Vec<_> = self
            .categories
            .iter()
            .map(|(e, c)| (e.clone(), c.clone(), if file.exe.contains_key(e) { "file" } else { "default" }))
            .collect();
        v.sort();
        v
    }
}

/// Exes in no table, longest time in front first, at most `limit`. `totals` is (exe, ms in front).
pub fn uncategorised(totals: &[(String, i64)], catalogue: &Catalogue, limit: usize) -> Vec<(String, i64)> {
    let mut v: Vec<(String, i64)> = totals
        .iter()
        .filter(|(exe, _)| !exe.is_empty() && catalogue.lookup(exe).is_none())
        .cloned()
        .collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v.truncate(limit);
    v
}

/// The line to paste under `[exe]` in `categories.toml`.
pub fn paste_line(exe: &str) -> String {
    format!("{} = \"...\"", toml::Value::String(exe.to_string()))
}

/// The text `categories init` writes: every shipped default, commented, so it can be edited in place.
pub fn init_text() -> String {
    let mut out = String::from(
        "# rhen-watch categories. The shipped defaults are listed here so you can change them in place;\n\
         # an exe you delete falls back to the default. This file is the only home for overrides.\n\
         # Add one with: rhen-watch categories set foo.exe editor\n\n\
         # exe file name (any case) -> category\n[exe]\n",
    );
    let mut last = "";
    for (exe, category) in DEFAULT_CATEGORIES {
        if *category != last {
            out.push_str(&format!("# {category}\n"));
            last = category;
        }
        out.push_str(&format!("\"{exe}\" = \"{category}\"\n"));
    }
    out.push_str(&format!(
        "\n# category -> group. Groups are only used for input stretches in the report: {}.\n# A browser is its own group; a category with no group counts as other.\n[group]\n",
        GROUPS.join(", ")
    ));
    for (category, group) in DEFAULT_GROUPS {
        out.push_str(&format!("{category} = \"{group}\"\n"));
    }
    out
}

const NEW_FILE: &str = "# rhen-watch category overrides. See `rhen-watch categories init` for every shipped default.\n\n[exe]\n";

/// `categories set`: add or change one `[exe]` entry in the text of `categories.toml` (or a new file),
/// keeping comments and layout. Returns the new text and any warnings.
pub fn set_entry(existing: Option<&str>, exe: &str, category: &str) -> Result<(String, Vec<String>), String> {
    let exe = normalise_exe(exe)?;
    validate_category(category)?;
    let category = category.to_ascii_lowercase(); // parsed that way; written that way
    let category = category.as_str();
    let mut doc: toml_edit::DocumentMut = existing
        .unwrap_or(NEW_FILE)
        .parse()
        .map_err(|e| format!("categories.toml is not valid TOML: {e}"))?;
    if !doc.contains_key("exe") {
        doc["exe"] = toml_edit::table();
    }
    let table = doc["exe"].as_table_like_mut().ok_or("categories.toml: [exe] is not a table")?;
    let mut new_value = toml_edit::Value::from(category);
    // A hand-written `"Code.exe"` is the same exe: change that entry rather than add a second, clashing one.
    let existing_key = table.iter().map(|(k, _)| k.to_string()).find(|k| k.to_ascii_lowercase() == exe);
    if let Some(item) = existing_key.as_deref().and_then(|k| table.get_mut(k)) {
        // Change the value in place so the key keeps the comments above it.
        if let Some(old) = item.as_value() {
            *new_value.decor_mut() = old.decor().clone();
        }
        *item = toml_edit::Item::Value(new_value);
    } else {
        table.insert(&exe, toml_edit::Item::Value(new_value));
    }
    let out = doc.to_string();
    let file = CategoryFile::parse(&out)?;
    let mut warnings = Vec::new();
    if Catalogue::with_file(&file, &[]).groupless().iter().any(|c| c == category) {
        warnings.push(format!(
            "category \"{category}\" has no group, so it counts as other; add `{category} = \"work\"` (or another of {}) under [group] in categories.toml",
            GROUPS.join(", ")
        ));
    }
    Ok((out, warnings))
}

/// `categories init --from-config`: the `[exe]` text for what the retired `config.toml [categories]` table held.
pub fn migrate_from_config(config_text: &str) -> Result<String, String> {
    let value: toml::Value = toml::from_str(config_text).map_err(|e| format!("config.toml: {e}"))?;
    let Some(table) = value.get("categories").and_then(|v| v.as_table()) else {
        return Err("config.toml has no [categories] table to migrate".into());
    };
    let mut out = String::from("[exe]\n");
    for (exe, category) in table {
        let category = category
            .as_str()
            .ok_or_else(|| format!("config.toml: [categories] \"{exe}\" must be a category name"))?;
        out.push_str(&format!(
            "{} = {}\n",
            toml::Value::String(exe.to_ascii_lowercase()),
            toml::Value::String(category.to_string())
        ));
    }
    CategoryFile::parse(&out)?;
    Ok(out)
}

/// (class, exe) pairs for windows whose class alone is also used by real apps: a CoreWindow owned by one
/// of these shell hosts is chrome, a CoreWindow owned by Calculator or Settings is the app.
pub const SHELL_PAIRS: &[(&str, &str)] = &[
    ("windows.ui.core.corewindow", "startmenuexperiencehost.exe"),
    ("windows.ui.core.corewindow", "searchhost.exe"),
    ("windows.ui.core.corewindow", "searchapp.exe"),
    ("windows.ui.core.corewindow", "shellexperiencehost.exe"),
    ("windows.ui.core.corewindow", "textinputhost.exe"),
];

/// Executables that are chrome whatever their window class: the lock screen is part of the lock, not app time.
pub const SHELL_EXES: &[&str] = &["lockapp.exe"];

pub fn is_shell_window(class: &str, exe: Option<&str>) -> bool {
    let class = class.to_ascii_lowercase();
    SHELL_CLASSES.contains(&class.as_str())
        || exe.is_some_and(|e| SHELL_EXES.contains(&e))
        || exe.is_some_and(|e| SHELL_PAIRS.iter().any(|(c, x)| *c == class && *x == e))
        || exe.is_some_and(crate::platform::macos_rules::is_shell_bundle)
}
