//! `config.toml`: which collectors run, retention and the numbers `report` derives with. A missing file
//! means defaults. Collectors that read window titles, URLs, screen text or images are off by default and
//! must be turned on one at a time. The per-exe category map lives in `categories.toml`, not here.

use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(try_from = "toml::Value")]
pub enum Retention {
    Word(String),
    Days(u32),
}

impl TryFrom<toml::Value> for Retention {
    type Error = String;

    fn try_from(v: toml::Value) -> Result<Self, String> {
        match v {
            toml::Value::String(w) => Ok(Retention::Word(w)),
            toml::Value::Integer(n) => u32::try_from(n)
                .map(Retention::Days)
                .map_err(|_| format!("retention must be \"permanent\" or a number of days, not {n}")),
            other => Err(format!("retention must be \"permanent\" or a number of days, not {other}")),
        }
    }
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
    pub input_buckets: Retention,
}

impl Default for RetentionCfg {
    fn default() -> Self {
        Self {
            events: Retention::Word("permanent".into()),
            metrics: Retention::Word("permanent".into()),
            input_buckets: Retention::Word("permanent".into()),
        }
    }
}

/// The numbers `report` uses to turn per-minute input into stretches and blocks. Numeric tunables, not switches.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Derive {
    /// Empty minutes (no engaged input) that still join two engaged minutes into one stretch.
    pub session_gap_minutes: u32,
    /// Fewest engaged minutes in one group for an input block to be listed.
    pub min_block_minutes: u32,
    /// Longest visit to another group (engaged minutes) that a block absorbs.
    pub detour_minutes: u32,
    /// Absorbed detours may total at most this share of a block's active minutes.
    pub detour_share_percent: u32,
    /// Input per minute, in seconds, for a minute to count as engaged.
    pub engaged_input_seconds: u32,
}

impl Default for Derive {
    fn default() -> Self {
        Self {
            session_gap_minutes: 5,
            min_block_minutes: 10,
            detour_minutes: 2,
            detour_share_percent: 25,
            engaged_input_seconds: 10,
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
    pub derive: Derive,
    /// The retired `[categories]` table, kept only to detect it (it moved to `categories.toml`).
    pub categories: Option<toml::Value>,
}

impl Config {
    /// Idle intervals and the input tally run only with the foreground collector: without it the agent cannot
    /// tell that a denylisted game is in front, and games must never be sampled.
    pub fn idle_enabled(&self) -> bool {
        self.collectors.idle && self.collectors.foreground
    }
}

pub const TEMPLATE: &str = r#"# rhen-watch configuration. Every setting shown is the default.
# Change one with `rhen-watch config set <key> <value>`; `rhen-watch config show` lists them all.
# The per-exe category map is a separate file: `rhen-watch categories init` writes categories.toml.

# Seconds without keyboard or mouse input before time counts as idle.
idle_threshold_secs = 120

# Programs the agent must do nothing at all for (it only notes that it was suppressed).
# The built-in list already covers common anti-cheat games.
extra_games = []

[collectors]
foreground = true   # which app is in front (executable name only)
idle = true         # idle intervals, and the per-minute input tally; needs foreground = true (games are spotted by it)
session = true      # lock, unlock, logon, logoff, remote sessions
power = true        # suspend, resume, display on/off, AC/battery
# Not built yet; setting either to true stops the agent with an error.
title = false       # window titles
ocr = false         # text read from the active window

[retention]
# "permanent" keeps everything. A number of days deletes older closed rows once a day.
events = "permanent"
metrics = "permanent"
input_buckets = "permanent"

[derive]
# Numbers `report` uses for "your day at the PC". They apply to the next report.
session_gap_minutes = 5      # empty minutes that still join two minutes of input into one stretch
min_block_minutes = 10       # fewest minutes of input in one group to list an input block
detour_minutes = 2           # a short visit to another group that a block absorbs
detour_share_percent = 25    # absorbed visits may total at most this share of a block
engaged_input_seconds = 10   # seconds of input in a minute for it to count as engaged
"#;

/// Message for a `[categories]` table left in `config.toml`.
pub const LEGACY_CATEGORIES: &str =
    "config.toml has a [categories] table; move it to categories.toml (run: rhen-watch categories init --from-config)";

/// Bytes of a text file as UTF-8: a BOM is stripped, UTF-16 (PowerShell 5 redirects write it) is refused clearly.
pub fn decode_text(bytes: &[u8], name: &str) -> Result<String, String> {
    let utf16 =
        bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) || (bytes.len() >= 2 && (bytes[0] != 0) != (bytes[1] != 0));
    if utf16 {
        return Err(format!(
            "{name} is saved as UTF-16 (a PowerShell 5 redirect does this); save it as UTF-8 and try again"
        ));
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8(bytes.to_vec()).map_err(|_| format!("{name} is not valid UTF-8; save it as UTF-8 and try again"))
}

/// The text of a file, or `None` when it does not exist.
pub fn read_text(path: &Path, name: &str) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => decode_text(&bytes, name).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// How a settable key is typed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    UInt,
    Bool,
    Retention,
    List,
}

/// Every key `config show` lists and `config set` accepts.
pub const KEYS: &[(&str, Kind)] = &[
    ("idle_threshold_secs", Kind::UInt),
    ("extra_games", Kind::List),
    ("collectors.foreground", Kind::Bool),
    ("collectors.idle", Kind::Bool),
    ("collectors.session", Kind::Bool),
    ("collectors.power", Kind::Bool),
    ("collectors.title", Kind::Bool),
    ("collectors.ocr", Kind::Bool),
    ("retention.events", Kind::Retention),
    ("retention.metrics", Kind::Retention),
    ("retention.input_buckets", Kind::Retention),
    ("derive.session_gap_minutes", Kind::UInt),
    ("derive.min_block_minutes", Kind::UInt),
    ("derive.detour_minutes", Kind::UInt),
    ("derive.detour_share_percent", Kind::UInt),
    ("derive.engaged_input_seconds", Kind::UInt),
];

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub key: &'static str,
    pub value: String,
    pub default: String,
    pub is_default: bool,
}

fn retention_text(r: &Retention) -> String {
    match r {
        Retention::Word(w) => w.clone(),
        Retention::Days(n) => n.to_string(),
    }
}

/// Keys the running agent reads only when it starts.
fn read_at_start(key: &str) -> bool {
    !key.starts_with("derive.")
}

const MAX_MINUTES: u32 = 1440;
/// One day; also keeps `secs * 1000` far from overflowing.
const MAX_IDLE_THRESHOLD_SECS: u64 = 86_400;

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        match read_text(path, "config.toml")? {
            Some(text) => Self::parse(&text),
            None => Ok(Self::default()),
        }
    }

    /// `run` and `report` stop on a leftover `[categories]` table rather than quietly ignoring it.
    pub fn reject_legacy_categories(&self) -> Result<(), String> {
        // The old `config init` template wrote an empty `[categories]` table (only a commented example); that
        // holds nothing to move, so only a table with entries (or something that is not a table) stops the agent.
        let has_entries = self.categories.as_ref().is_some_and(|v| v.as_table().is_none_or(|t| !t.is_empty()));
        if has_entries { Err(LEGACY_CATEGORIES.into()) } else { Ok(()) }
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
        if let Some(n) = self.idle_threshold_secs
            && !(1..=MAX_IDLE_THRESHOLD_SECS).contains(&n)
        {
            return Err(format!("idle_threshold_secs must be between 1 and {MAX_IDLE_THRESHOLD_SECS}"));
        }
        self.retention.events.days().map_err(|e| format!("retention.events: {e}"))?;
        self.retention.metrics.days().map_err(|e| format!("retention.metrics: {e}"))?;
        self.retention
            .input_buckets
            .days()
            .map_err(|e| format!("retention.input_buckets: {e}"))?;
        let d = &self.derive;
        for (key, v, max) in [
            ("derive.session_gap_minutes", d.session_gap_minutes, MAX_MINUTES),
            ("derive.min_block_minutes", d.min_block_minutes, MAX_MINUTES),
            ("derive.detour_minutes", d.detour_minutes, MAX_MINUTES),
            ("derive.detour_share_percent", d.detour_share_percent, 100),
            ("derive.engaged_input_seconds", d.engaged_input_seconds, 60),
        ] {
            if !(1..=max).contains(&v) {
                return Err(format!("{key} must be between 1 and {max}"));
            }
        }
        if d.min_block_minutes < d.detour_minutes {
            return Err(format!(
                "derive.min_block_minutes ({}) must be at least derive.detour_minutes ({})",
                d.min_block_minutes, d.detour_minutes
            ));
        }
        Ok(())
    }

    /// Every key with its current value and whether that is the default.
    pub fn entries(&self) -> Vec<Entry> {
        let d = Derive::default();
        let r = RetentionCfg::default();
        let c = Collectors::default();
        let list = |v: &[String]| format!("[{}]", v.join(", "));
        let mut out = Vec::new();
        let mut add = |key: &'static str, value: String, default: String| {
            out.push(Entry {
                key,
                is_default: value == default,
                value,
                default,
            });
        };
        add(
            "idle_threshold_secs",
            self.idle_threshold_secs.unwrap_or(120).to_string(),
            "120".into(),
        );
        add("extra_games", list(&self.extra_games), "[]".into());
        add(
            "collectors.foreground",
            self.collectors.foreground.to_string(),
            c.foreground.to_string(),
        );
        add("collectors.idle", self.collectors.idle.to_string(), c.idle.to_string());
        add("collectors.session", self.collectors.session.to_string(), c.session.to_string());
        add("collectors.power", self.collectors.power.to_string(), c.power.to_string());
        add("collectors.title", self.collectors.title.to_string(), c.title.to_string());
        add("collectors.ocr", self.collectors.ocr.to_string(), c.ocr.to_string());
        add(
            "retention.events",
            retention_text(&self.retention.events),
            retention_text(&r.events),
        );
        add(
            "retention.metrics",
            retention_text(&self.retention.metrics),
            retention_text(&r.metrics),
        );
        add(
            "retention.input_buckets",
            retention_text(&self.retention.input_buckets),
            retention_text(&r.input_buckets),
        );
        add(
            "derive.session_gap_minutes",
            self.derive.session_gap_minutes.to_string(),
            d.session_gap_minutes.to_string(),
        );
        add(
            "derive.min_block_minutes",
            self.derive.min_block_minutes.to_string(),
            d.min_block_minutes.to_string(),
        );
        add(
            "derive.detour_minutes",
            self.derive.detour_minutes.to_string(),
            d.detour_minutes.to_string(),
        );
        add(
            "derive.detour_share_percent",
            self.derive.detour_share_percent.to_string(),
            d.detour_share_percent.to_string(),
        );
        add(
            "derive.engaged_input_seconds",
            self.derive.engaged_input_seconds.to_string(),
            d.engaged_input_seconds.to_string(),
        );
        out
    }
}

/// `config show`: one line per key; a changed key shows the default beside it.
pub fn show(cfg: &Config) -> String {
    let mut out = String::new();
    for e in cfg.entries() {
        if e.is_default {
            out.push_str(&format!("{:<32} = {}  (default)\n", e.key, e.value));
        } else {
            out.push_str(&format!("{:<32} = {}  (default: {})\n", e.key, e.value, e.default));
        }
    }
    out
}

/// A parse error on one line: the TOML position (line and column) when there is one, then the reason.
fn short_error(e: &str) -> String {
    let e = e.strip_prefix("config.toml: ").unwrap_or(e);
    let lines: Vec<&str> = e.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    match (lines.first(), lines.last()) {
        (Some(first), Some(last)) if lines.len() > 1 && first.starts_with("TOML parse error") => format!("{first}: {last}"),
        (_, Some(last)) => (*last).to_string(),
        _ => e.to_string(),
    }
}

/// Write a file so a crash leaves the old or the new one, never a half-written one: write a temp file beside it,
/// flush it to disk, then rename it over the target.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension("toml.tmp");
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        // Without this a power loss just after the rename can leave the file present but empty or zero-filled.
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot write {}: {e}", tmp.display()));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot replace {}: {e}", path.display()));
    }
    Ok(())
}

/// `config show` against a file: a leftover `[categories]` table is an error here too, as it is for `run`.
pub fn show_file(path: &Path) -> Result<String, String> {
    let cfg = Config::load(path)?;
    cfg.reject_legacy_categories()?;
    Ok(show(&cfg))
}

/// Set one key in the text of `config.toml`, keeping its comments and layout. The result is validated the same
/// way a loaded file is; on any failure the caller's text is untouched and the error is one line naming the key.
pub fn set_key(text: &str, key: &str, value: &str) -> Result<String, String> {
    let Some((_, kind)) = KEYS.iter().find(|(k, _)| *k == key) else {
        return Err(format!("{key}: unknown key; run `rhen-watch config show` for the keys"));
    };
    let new_value: toml_edit::Value = match kind {
        Kind::UInt => {
            let n: u64 = value.trim().parse().map_err(|_| format!("{key} must be a whole number"))?;
            toml_edit::Value::from(i64::try_from(n).map_err(|_| format!("{key} is too large"))?)
        }
        Kind::Bool => match value.trim().to_ascii_lowercase().as_str() {
            "true" => true.into(),
            "false" => false.into(),
            _ => return Err(format!("{key} must be true or false")),
        },
        Kind::Retention => match value.trim().parse::<u32>() {
            Ok(n) => i64::from(n).into(),
            Err(_) => value.trim().to_string().into(),
        },
        Kind::List => {
            let mut arr = toml_edit::Array::new();
            for item in value.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                arr.push(item);
            }
            arr.into()
        }
    };
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| format!("{key}: config.toml is not valid TOML: {e}"))?;
    let path: Vec<&str> = key.split('.').collect();
    let root = doc.as_table_mut();
    let item = match path.as_slice() {
        [name] => root.entry(name).or_insert(toml_edit::Item::None),
        [table, name] => {
            // A file may hold a plain value where a table belongs (`derive = 5`); that is an error, not a panic.
            let tbl = root.entry(table).or_insert_with(toml_edit::table);
            let tbl = tbl
                .as_table_like_mut()
                .ok_or_else(|| format!("{key}: `{table}` in config.toml is not a table"))?;
            tbl.entry(name).or_insert(toml_edit::Item::None)
        }
        _ => return Err(format!("{key}: unknown key; run `rhen-watch config show` for the keys")),
    };
    let mut new_value = new_value;
    if let Some(old) = item.as_value() {
        // Keep the comment that trails the old value.
        *new_value.decor_mut() = old.decor().clone();
    } else {
        new_value.decor_mut().set_prefix(" ");
    }
    *item = toml_edit::Item::Value(new_value);
    let out = doc.to_string();
    if let Err(e) = Config::parse(&out) {
        // If the file was already bad, the problem is not the key being set: say where it really is.
        if let Err(before) = Config::parse(text) {
            return Err(format!("config.toml already has a problem: {}; fix it first", short_error(&before)));
        }
        let e = short_error(&e);
        return Err(if e.contains(key) { e } else { format!("{key}: {e}") });
    }
    Ok(out)
}

/// `config set` against a file: start from the template when there is none, write atomically, return the note
/// that says when the change applies.
pub fn set_and_write(path: &Path, key: &str, value: &str) -> Result<String, String> {
    let text = read_text(path, "config.toml")?.unwrap_or_else(|| TEMPLATE.to_string());
    let out = set_key(&text, key, value)?;
    write_atomic(path, &out)?;
    let mut note = if read_at_start(key) {
        format!("{key} set; takes effect when the agent restarts")
    } else {
        format!("{key} set; applies to the next report")
    };
    // The set itself is valid, but a leftover table still stops `run`: do not promise a restart works.
    if Config::parse(&out).is_ok_and(|c| c.reject_legacy_categories().is_err()) {
        note.push_str(", but the agent will not start until the [categories] table is moved (rhen-watch categories init --from-config)");
    }
    Ok(note)
}
