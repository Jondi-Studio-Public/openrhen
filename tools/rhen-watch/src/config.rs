//! `config.toml`: which collectors run, retention, and the app tables. A missing file means defaults.
//! Collectors that read window titles, URLs, screen text or images are off by default and must be turned
//! on one at a time.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Retention {
    Word(String),
    Days(u32),
}

impl Retention {
    /// `None` means keep forever.
    pub fn days(&self) -> Result<Option<u32>, String> {
        match self {
            Retention::Days(0) => Err("retention of 0 days would delete everything; use \"permanent\" to keep it all".into()),
            Retention::Days(n) => Ok(Some(*n)),
            Retention::Word(w) if w.eq_ignore_ascii_case("permanent") => Ok(None),
            Retention::Word(w) => Err(format!("retention must be \"permanent\" or a number of days, not \"{w}\"")),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Collectors {
    pub foreground: bool,
    pub idle: bool,
    pub session: bool,
    pub power: bool,
    /// Window titles. Not built yet; setting it is an error so nobody believes it is recording.
    pub title: bool,
    /// Screen text by OCR. Not built yet, same rule.
    pub ocr: bool,
}

impl Default for Collectors {
    fn default() -> Self {
        Self {
            foreground: true,
            idle: true,
            session: true,
            power: true,
            title: false,
            ocr: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RetentionCfg {
    pub events: Retention,
    pub metrics: Retention,
}

impl Default for RetentionCfg {
    fn default() -> Self {
        Self {
            events: Retention::Word("permanent".into()),
            metrics: Retention::Word("permanent".into()),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub idle_threshold_secs: Option<u64>,
    pub collectors: Collectors,
    pub retention: RetentionCfg,
    /// Extra executables (file names) to leave completely alone, on top of the built-in game list.
    pub extra_games: Vec<String>,
    /// exe file name -> category, overriding the built-in table.
    pub categories: HashMap<String, String>,
}

pub const TEMPLATE: &str = r#"# rhen-watch configuration. Every setting shown is the default.

# Seconds without keyboard or mouse input before time counts as idle.
idle_threshold_secs = 120

# Programs the agent must do nothing at all for (it only notes that it was suppressed).
# The built-in list already covers common anti-cheat games.
extra_games = []

[collectors]
foreground = true   # which app is in front (executable name only)
idle = true
session = true      # lock, unlock, logon, logoff, remote sessions
power = true        # suspend, resume, display on/off, AC/battery
# Not built yet; setting either to true stops the agent with an error.
title = false       # window titles
ocr = false         # text read from the active window

[retention]
# "permanent" keeps everything. A number of days deletes older closed rows once a day.
events = "permanent"
metrics = "permanent"

# exe file name -> category. Overrides the built-in table.
[categories]
# "mything.exe" = "editor"
"#;

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::parse(&text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("cannot read {}: {e}", path.display())),
        }
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let cfg: Config = toml::from_str(text).map_err(|e| format!("config.toml: {e}"))?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.collectors.title || self.collectors.ocr {
            return Err("collectors.title and collectors.ocr are not built yet in this version; set them to false".into());
        }
        if let Some(0) = self.idle_threshold_secs {
            return Err("idle_threshold_secs must be at least 1".into());
        }
        self.retention.events.days().map_err(|e| format!("retention.events: {e}"))?;
        self.retention.metrics.days().map_err(|e| format!("retention.metrics: {e}"))?;
        Ok(())
    }
}
