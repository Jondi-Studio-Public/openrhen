//! The settings window's decisions as pure data, so they are tested on any OS: what state the agent is in, what
//! each button says and whether it is enabled, how a retention choice is read and what it would delete, what the
//! start-up checkbox means, which apps are listed, and the names the window and the agent agree on. The Windows
//! layer (`platform::windows_app`) only draws this and does what the buttons say.

use crate::categories::{Catalogue, SHELL_EXES, uncategorised};
use crate::config::Retention;
use crate::report::fmt_duration;
use crate::runner::Control;
use crate::tray::TrayIcon;

// ---- names shared by the agent and the window ----

/// The registered window message the settings window posts to the agent's window. Registered messages are numbered
/// from `REGISTERED_MESSAGE_MIN` up, so it cannot clash with the agent's private `WM_APP` messages.
pub const CONTROL_MESSAGE_NAME: &str = "rhen-watch.control";
pub const REGISTERED_MESSAGE_MIN: u32 = 0xC000;
/// The first `WM_APP` message number. Private messages are `WM_APP + n`; they end below `REGISTERED_MESSAGE_MIN`.
pub const WM_APP_BASE: u32 = 0x8000;
/// `wparam` of the control message: what to do.
pub const VERB_PAUSE: usize = 1;
pub const VERB_RESUME: usize = 2;

/// The agent's hidden window class (its title is `paths::agent_window_title`).
pub const AGENT_WINDOW_CLASS: &str = "rhen-watch-hidden";
/// The settings window's class. Install and uninstall find an open window by it and close it; a second launch finds
/// the first by it and focuses that one.
pub const APP_WINDOW_CLASS: &str = "rhen-watch-app";
/// The process-level AppUserModelID of the settings window (so the taskbar groups it as one app).
pub const APP_USER_MODEL_ID: &str = "org.openrhen.rhen-watch";

pub fn verb_for(c: Control) -> usize {
    match c {
        Control::Pause => VERB_PAUSE,
        Control::Resume => VERB_RESUME,
    }
}

/// The command a control message carries; an unknown verb is ignored, not guessed at.
pub fn control_for_verb(verb: usize) -> Option<Control> {
    match verb {
        VERB_PAUSE => Some(Control::Pause),
        VERB_RESUME => Some(Control::Resume),
        _ => None,
    }
}

// ---- what state the agent is in ----

/// Written by the agent whenever the runner state changes (`recording`, `paused` or `degraded`), so the window can
/// show it without asking the process. Listed in `handover::OWNED`.
pub const STATE_FILE: &str = "state.txt";

pub fn state_file_text(runner_state: &str) -> String {
    match runner_state {
        "paused" | "degraded" => runner_state.to_string(),
        _ => "recording".to_string(),
    }
}

/// What the window can see from outside the agent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentFacts {
    /// `run.lock` is held by another process.
    pub lock_held: bool,
    /// The agent's hidden window (class and per-directory title) exists.
    pub window_found: bool,
    pub state_file: Option<String>,
    /// Why the last start was refused (`not-starting.txt`).
    pub not_starting: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunState {
    Recording,
    Paused,
    Degraded,
    NotRunning,
    /// Not running, and the last start said why it was refused.
    NotStarting(String),
    /// The lock is held but no agent window answers to this directory: an agent from before the settings window
    /// existed, or one that is still starting. It cannot be controlled from here.
    Unreachable,
}

pub fn resolve_state(f: &AgentFacts) -> RunState {
    if f.lock_held {
        if !f.window_found {
            return RunState::Unreachable;
        }
        return match f.state_file.as_deref().map(str::trim) {
            Some("paused") => RunState::Paused,
            Some("degraded") => RunState::Degraded,
            _ => RunState::Recording,
        };
    }
    match f.not_starting.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        Some(reason) => RunState::NotStarting(reason.to_string()),
        None => RunState::NotRunning,
    }
}

impl RunState {
    pub fn icon(&self) -> TrayIcon {
        match self {
            RunState::Paused => TrayIcon::Paused,
            RunState::Degraded | RunState::NotStarting(_) | RunState::Unreachable => TrayIcon::Degraded,
            RunState::Recording | RunState::NotRunning => TrayIcon::Recording,
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(
            self,
            RunState::Recording | RunState::Paused | RunState::Degraded | RunState::Unreachable
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Button {
    pub text: &'static str,
    pub enabled: bool,
}

/// What the Overview tab shows for a state. `busy` is an action in flight: nothing can be pressed meanwhile.
#[derive(Debug, Clone, PartialEq)]
pub struct Overview {
    pub headline: String,
    pub detail: String,
    pub pause: Button,
    pub stop: Button,
    pub start: Button,
}

/// The line under the headline on every tab of the Overview.
pub const PRIVACY_LINE: &str = "Data stays on this PC. rhen-watch has no network code.";

pub fn overview(state: &RunState, busy: bool) -> Overview {
    let (headline, detail): (&str, String) = match state {
        RunState::Recording => (
            "Recording",
            "Recording which app is in front, when you are idle, and when the PC locks or sleeps.".into(),
        ),
        RunState::Paused => ("Paused", "Nothing is recorded until you resume. A restart stays paused.".into()),
        RunState::Degraded => (
            "Recording, with problems",
            "Writes to the database are failing. See rhen-watch.log in the data folder.".into(),
        ),
        RunState::NotRunning => ("Not recording", "Nothing is being recorded. Press Start recording.".into()),
        RunState::NotStarting(reason) => ("Not recording", format!("Recording could not start: {reason}")),
        RunState::Unreachable => (
            "Recording (cannot be controlled here)",
            "An agent is running that this window cannot reach: one started by an older version, or one that is still \
             starting. Quit it from its tray icon (or run rhen-watch stop), then press Start recording."
                .into(),
        ),
    };
    let controllable = !busy && matches!(state, RunState::Recording | RunState::Paused | RunState::Degraded);
    Overview {
        headline: headline.into(),
        detail,
        pause: Button {
            text: if *state == RunState::Paused {
                "Resume recording"
            } else {
                "Pause recording"
            },
            enabled: controllable,
        },
        stop: Button {
            text: "Stop recording",
            enabled: controllable,
        },
        start: Button {
            text: "Start recording",
            enabled: !busy && matches!(state, RunState::NotRunning | RunState::NotStarting(_)),
        },
    }
}

/// How `Start recording` launches the agent: through the scheduled task when there is one (the task only restarts
/// a process it launched), directly only when there is none (the Run-key fallback, or start-up turned off).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StartPlan {
    Task,
    Direct,
}

pub fn start_plan(task_present: bool) -> StartPlan {
    if task_present { StartPlan::Task } else { StartPlan::Direct }
}

/// The report box wants Windows line breaks.
pub fn to_crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

// ---- start with Windows ----

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AutostartKind {
    /// Both scheduled tasks: starts at logon and is restarted after a crash.
    Task,
    /// Only the Run entry: starts at logon, no restart.
    RunEntry,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AutostartState {
    On(AutostartKind),
    Off,
    /// Half set: one task of the two. Repairing is turning it on.
    Partial(String),
}

/// `tasks` is how many of the two tasks are registered (0, 1 or 2); `run_entry` is the HKCU Run value.
pub fn autostart_state(tasks: usize, run_entry: bool) -> AutostartState {
    match (tasks, run_entry) {
        (2, _) => AutostartState::On(AutostartKind::Task),
        (0, true) => AutostartState::On(AutostartKind::RunEntry),
        (0, false) => AutostartState::Off,
        _ => AutostartState::Partial(format!("only {tasks} of the 2 start-up tasks is registered")),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AutostartIntent {
    Enable,
    Disable,
    Unchanged,
}

/// What pressing Apply does with the checkbox: a half-set state is repaired by either box state (checked: turn it
/// on, unchecked: remove what is left).
pub fn autostart_intent(state: &AutostartState, checked: bool) -> AutostartIntent {
    match (state, checked) {
        (AutostartState::On(_), true) | (AutostartState::Off, false) => AutostartIntent::Unchanged,
        (_, true) => AutostartIntent::Enable,
        (_, false) => AutostartIntent::Disable,
    }
}

pub const AUTOSTART_LABEL: &str = "Start with Windows";

/// The line under the checkbox, for the state it is in and what the box now says.
pub fn autostart_note(state: &AutostartState, checked: bool) -> String {
    match autostart_intent(state, checked) {
        AutostartIntent::Disable => "Turned off when you press Apply: rhen-watch will not start when you log on, and it will not be \
             restarted after a crash either. It stays closed after you log off until you open it."
            .into(),
        AutostartIntent::Enable => match state {
            AutostartState::Partial(why) => {
                format!(
                    "Start-up is only partly set ({why}). Apply repairs it: rhen-watch then starts when you log on and is restarted if it crashes."
                )
            }
            _ => "Turned on when you press Apply: rhen-watch starts when you log on and is restarted if it crashes.".into(),
        },
        AutostartIntent::Unchanged => match state {
            AutostartState::On(AutostartKind::Task) => "On: starts when you log on and is restarted if it crashes.".into(),
            AutostartState::On(AutostartKind::RunEntry) => {
                "On, without restart after a crash (the scheduled tasks could not be registered). Starts when you log on.".into()
            }
            AutostartState::Off => "Off: rhen-watch does not start when you log on, and is not restarted after a crash.".into(),
            AutostartState::Partial(why) => format!("Start-up is only partly set ({why}). Tick the box and press Apply to repair it."),
        },
    }
}

// ---- how long to keep data ----

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Keep {
    Forever,
    Days(u32),
}

/// The choices the box lists; anything else can be typed (`45`, `45 days`).
pub const KEEP_PRESETS: [&str; 5] = ["Forever", "30 days", "90 days", "180 days", "365 days"];
const MAX_KEEP_DAYS: u32 = 36_500;

pub fn keep_label(k: Keep) -> String {
    match k {
        Keep::Forever => "Forever".into(),
        Keep::Days(1) => "1 day".into(),
        Keep::Days(n) => format!("{n} days"),
    }
}

pub fn parse_keep(text: &str) -> Result<Keep, String> {
    let t = text.trim().to_ascii_lowercase();
    if t == "forever" || t == "permanent" {
        return Ok(Keep::Forever);
    }
    let digits = t.strip_suffix("days").or_else(|| t.strip_suffix("day")).unwrap_or(&t).trim();
    match digits.parse::<u32>() {
        Ok(0) => Err("Keep data: 0 days would delete everything; choose Forever to keep it all".into()),
        Ok(n) if n > MAX_KEEP_DAYS => Err(format!("Keep data: at most {MAX_KEEP_DAYS} days; choose Forever to keep it all")),
        Ok(n) => Ok(Keep::Days(n)),
        Err(_) => Err("Keep data: choose Forever or type a number of days (for example 90)".into()),
    }
}

/// What the config file says, as a choice. A value the file should not have (`retention` already fails
/// `Config::validate`) is refused rather than shown as something else.
pub fn keep_from_retention(r: &Retention) -> Result<Keep, String> {
    Ok(match r.days()? {
        None => Keep::Forever,
        Some(n) => Keep::Days(n),
    })
}

/// The value `config set retention.events` takes.
pub fn keep_config_value(k: Keep) -> String {
    match k {
        Keep::Forever => "permanent".into(),
        Keep::Days(n) => n.to_string(),
    }
}

fn thousands(n: i64) -> String {
    let digits = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/// The question to ask before a shorter retention is saved, or `None` when nothing recorded is that old (or the
/// choice is Forever). `events_older` and `buckets_older` are how many stored events and per-minute input tallies are
/// older than the cutoff (both are deleted); `oldest_days` is the age of the oldest event.
pub fn retention_confirm(keep: Keep, events_older: i64, buckets_older: i64, oldest_days: Option<i64>) -> Option<String> {
    let Keep::Days(days) = keep else { return None };
    if events_older <= 0 && buckets_older <= 0 {
        return None;
    }
    let events = if events_older == 1 {
        "1 recorded event".to_string()
    } else {
        format!("{} recorded events", thousands(events_older.max(0)))
    };
    let tallies = if buckets_older > 0 {
        format!(" and {} per-minute input tallies", thousands(buckets_older))
    } else {
        String::new()
    };
    let oldest = oldest_days
        .map(|d| format!(" (the oldest event is {d} days old)"))
        .unwrap_or_default();
    Some(format!(
        "Keeping {} will permanently delete {events}{tallies} older than that{oldest}, at the next daily clean-up (and when \
         recording starts). This cannot be undone. Save this setting?",
        keep_label(Keep::Days(days))
    ))
}

#[derive(Debug, Clone, PartialEq)]
pub struct SettingsPlan {
    pub keep: Keep,
    pub idle_secs: u64,
}

/// Read the Settings tab's boxes. Range checks on the idle threshold are `Config::validate`'s, so the numbers have
/// one home; this only refuses what is not a number.
pub fn plan_settings(keep_text: &str, idle_text: &str) -> Result<SettingsPlan, String> {
    let keep = parse_keep(keep_text)?;
    let idle_secs = idle_text
        .trim()
        .parse::<u64>()
        .map_err(|_| "Idle after: type a whole number of seconds (for example 120)".to_string())?;
    Ok(SettingsPlan { keep, idle_secs })
}

/// The `config set` writes for a plan: retention for events and for the per-minute input tally (the metrics
/// retention is left as the file has it), and the idle threshold.
pub fn settings_writes(p: &SettingsPlan) -> Vec<(&'static str, String)> {
    vec![
        ("retention.events", keep_config_value(p.keep)),
        ("retention.input_buckets", keep_config_value(p.keep)),
        ("idle_threshold_secs", p.idle_secs.to_string()),
    ]
}

// ---- the Apps tab ----

/// How many apps the list holds.
pub const APPS_LIMIT: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct AppRow {
    pub exe: String,
    pub ms: i64,
}

impl AppRow {
    pub fn label(&self) -> String {
        format!("{}    {}", self.exe, fmt_duration(self.ms))
    }
}

/// Apps in no category table, most time first. rhen-watch's own programs are left out: an older database may hold
/// rows for them from before they were treated as part of the shell.
pub fn app_rows(totals: &[(String, i64)], catalogue: &Catalogue) -> Vec<AppRow> {
    let own: Vec<(String, i64)> = totals.iter().filter(|(e, _)| !SHELL_EXES.contains(&e.as_str())).cloned().collect();
    uncategorised(&own, catalogue, APPS_LIMIT)
        .into_iter()
        .map(|(exe, ms)| AppRow { exe, ms })
        .collect()
}

/// The categories in use, sorted, for the category box (the third field of `Catalogue::entries`' tuples is where
/// an entry came from and is not needed here).
pub fn categories_in_use(entries: &[(String, String, &'static str)]) -> Vec<String> {
    let set: std::collections::BTreeSet<&str> = entries.iter().map(|(_, c, _)| c.as_str()).collect();
    set.into_iter().map(str::to_string).collect()
}

/// Said after a category is set.
pub const RESTART_NOTE: &str = "Takes effect when recording restarts (and in the next report).";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tray::{TRAY_MSG_OFFSET, TRAY_REFRESH_MSG_OFFSET};

    fn facts(lock: bool, window: bool, state: Option<&str>, why: Option<&str>) -> AgentFacts {
        AgentFacts {
            lock_held: lock,
            window_found: window,
            state_file: state.map(String::from),
            not_starting: why.map(String::from),
        }
    }

    #[test]
    fn the_control_message_cannot_clash_with_the_agents_private_messages() {
        // WM_APP + n stays below the registered range, which is where RegisterWindowMessageW numbers come from.
        assert!(WM_APP_BASE + TRAY_MSG_OFFSET.max(TRAY_REFRESH_MSG_OFFSET) < REGISTERED_MESSAGE_MIN);
        assert_ne!(TRAY_MSG_OFFSET, TRAY_REFRESH_MSG_OFFSET);
        assert_eq!(CONTROL_MESSAGE_NAME, "rhen-watch.control");
    }

    #[test]
    fn control_verbs_round_trip_and_unknown_verbs_do_nothing() {
        for c in [Control::Pause, Control::Resume] {
            assert_eq!(control_for_verb(verb_for(c)), Some(c));
        }
        assert_eq!(control_for_verb(0), None);
        assert_eq!(control_for_verb(3), None, "there is no stop verb: stop uses the stop event");
    }

    #[test]
    fn the_state_file_only_ever_holds_one_of_three_words() {
        assert_eq!(state_file_text("paused"), "paused");
        assert_eq!(state_file_text("degraded"), "degraded");
        assert_eq!(state_file_text("recording"), "recording");
        assert_eq!(state_file_text("anything else"), "recording");
    }

    #[test]
    fn state_is_resolved_from_what_can_be_seen_from_outside() {
        use RunState::*;
        assert_eq!(resolve_state(&facts(true, true, Some("recording"), None)), Recording);
        assert_eq!(resolve_state(&facts(true, true, Some("paused\n"), None)), Paused);
        assert_eq!(resolve_state(&facts(true, true, Some("degraded"), None)), Degraded);
        assert_eq!(
            resolve_state(&facts(true, true, None, None)),
            Recording,
            "no file yet: the agent has just started"
        );
        assert_eq!(
            resolve_state(&facts(true, false, Some("paused"), None)),
            Unreachable,
            "lock held, no window"
        );
        assert_eq!(
            resolve_state(&facts(false, false, Some("paused"), None)),
            NotRunning,
            "a stale state file means nothing"
        );
        assert_eq!(resolve_state(&facts(false, false, None, Some("  "))), NotRunning);
        assert_eq!(
            resolve_state(&facts(false, false, Some("recording"), Some("bad config\n"))),
            NotStarting("bad config".into())
        );
        assert_eq!(
            resolve_state(&facts(true, true, Some("recording"), Some("stale"))),
            Recording,
            "a running agent outranks an old refusal"
        );
    }

    #[test]
    fn buttons_follow_the_state() {
        let rec = overview(&RunState::Recording, false);
        assert_eq!((rec.headline.as_str(), rec.pause.text), ("Recording", "Pause recording"));
        assert!(rec.pause.enabled && rec.stop.enabled && !rec.start.enabled);

        let paused = overview(&RunState::Paused, false);
        assert_eq!((paused.headline.as_str(), paused.pause.text), ("Paused", "Resume recording"));
        assert!(paused.pause.enabled && paused.stop.enabled && !paused.start.enabled);

        let off = overview(&RunState::NotRunning, false);
        assert_eq!(off.headline, "Not recording");
        assert!(!off.pause.enabled && !off.stop.enabled && off.start.enabled);

        let refused = overview(&RunState::NotStarting("config.toml: bad".into()), false);
        assert!(refused.detail.contains("config.toml: bad") && refused.start.enabled);

        let old = overview(&RunState::Unreachable, false);
        assert!(
            !old.pause.enabled && !old.stop.enabled && !old.start.enabled,
            "nothing to press, and it says why"
        );
        assert!(old.detail.contains("Quit it from its tray icon"));

        let degraded = overview(&RunState::Degraded, false);
        assert!(degraded.headline.contains("problems") && degraded.pause.enabled);

        let busy = overview(&RunState::Recording, true);
        assert!(
            !busy.pause.enabled && !busy.stop.enabled && !busy.start.enabled,
            "nothing is pressable mid-action"
        );
        assert!(!overview(&RunState::NotRunning, true).start.enabled);
    }

    #[test]
    fn the_window_icon_follows_the_state() {
        assert_eq!(RunState::Paused.icon(), TrayIcon::Paused);
        assert_eq!(RunState::Recording.icon(), TrayIcon::Recording);
        assert_eq!(RunState::Degraded.icon(), TrayIcon::Degraded);
        assert!(RunState::Paused.is_running() && !RunState::NotRunning.is_running());
        assert!(!RunState::NotStarting("x".into()).is_running());
    }

    #[test]
    fn start_goes_through_the_task_when_there_is_one() {
        assert_eq!(start_plan(true), StartPlan::Task);
        assert_eq!(start_plan(false), StartPlan::Direct);
    }

    #[test]
    fn report_text_gets_windows_line_breaks_once() {
        assert_eq!(to_crlf("a\nb\r\nc"), "a\r\nb\r\nc");
    }

    #[test]
    fn autostart_state_needs_both_tasks_or_the_run_entry_and_a_half_set_state_is_an_error() {
        assert_eq!(autostart_state(2, false), AutostartState::On(AutostartKind::Task));
        assert_eq!(
            autostart_state(2, true),
            AutostartState::On(AutostartKind::Task),
            "the lock keeps a second copy out"
        );
        assert_eq!(autostart_state(0, true), AutostartState::On(AutostartKind::RunEntry));
        assert_eq!(autostart_state(0, false), AutostartState::Off);
        assert!(matches!(autostart_state(1, false), AutostartState::Partial(_)));
        assert!(matches!(autostart_state(1, true), AutostartState::Partial(_)));
    }

    #[test]
    fn the_checkbox_changes_start_up_only_when_it_differs_from_the_state() {
        let on = AutostartState::On(AutostartKind::Task);
        let partial = AutostartState::Partial("x".into());
        assert_eq!(autostart_intent(&on, true), AutostartIntent::Unchanged);
        assert_eq!(autostart_intent(&on, false), AutostartIntent::Disable);
        assert_eq!(autostart_intent(&AutostartState::Off, false), AutostartIntent::Unchanged);
        assert_eq!(autostart_intent(&AutostartState::Off, true), AutostartIntent::Enable);
        assert_eq!(autostart_intent(&partial, true), AutostartIntent::Enable);
        assert_eq!(autostart_intent(&partial, false), AutostartIntent::Disable);
    }

    #[test]
    fn turning_start_up_off_says_the_app_stays_closed_and_crash_restart_goes_too() {
        let note = autostart_note(&AutostartState::On(AutostartKind::Task), false);
        assert!(note.contains("will not start when you log on"), "{note}");
        assert!(note.contains("not be restarted after a crash"), "{note}");
        assert!(note.contains("stays closed after you log off"), "{note}");
        assert!(autostart_note(&AutostartState::On(AutostartKind::RunEntry), true).contains("without restart"));
        assert!(autostart_note(&AutostartState::Partial("only 1".into()), true).contains("repair"));
    }

    #[test]
    fn keep_is_forever_or_a_number_of_days_and_nothing_else() {
        assert_eq!(parse_keep("Forever"), Ok(Keep::Forever));
        assert_eq!(parse_keep(" permanent "), Ok(Keep::Forever));
        assert_eq!(parse_keep("90"), Ok(Keep::Days(90)));
        assert_eq!(parse_keep("90 days"), Ok(Keep::Days(90)));
        assert_eq!(parse_keep("1 Day"), Ok(Keep::Days(1)));
        assert!(parse_keep("0").unwrap_err().contains("delete everything"));
        assert!(parse_keep("0 days").is_err());
        assert!(parse_keep("-5").is_err());
        assert!(parse_keep("abc").is_err());
        assert!(parse_keep("").is_err());
        assert!(parse_keep("36501").is_err());
        assert_eq!(parse_keep("36500"), Ok(Keep::Days(36_500)));
        for p in KEEP_PRESETS {
            assert!(parse_keep(p).is_ok(), "{p}");
            assert_eq!(keep_label(parse_keep(p).unwrap()), p, "the preset reads back as itself");
        }
        assert_eq!(keep_label(Keep::Days(1)), "1 day");
    }

    #[test]
    fn keep_maps_to_and_from_the_config_values() {
        assert_eq!(keep_config_value(Keep::Forever), "permanent");
        assert_eq!(keep_config_value(Keep::Days(45)), "45");
        assert_eq!(keep_from_retention(&Retention::Word("permanent".into())), Ok(Keep::Forever));
        assert_eq!(keep_from_retention(&Retention::Days(30)), Ok(Keep::Days(30)));
        assert!(keep_from_retention(&Retention::Word("soon".into())).is_err());
        assert!(keep_from_retention(&Retention::Days(0)).is_err());
    }

    #[test]
    fn a_shorter_retention_says_what_it_will_delete() {
        let q = retention_confirm(Keep::Days(30), 12_345, 0, Some(95)).unwrap();
        assert!(q.contains("30 days"), "{q}");
        assert!(q.contains("12,345 recorded events"), "{q}");
        assert!(q.contains("the oldest event is 95 days old"), "{q}");
        assert!(q.contains("cannot be undone"), "{q}");
        assert!(
            retention_confirm(Keep::Days(1), 1, 0, None)
                .unwrap()
                .contains("Keeping 1 day will permanently delete 1 recorded event ")
        );
        assert_eq!(
            retention_confirm(Keep::Days(30), 0, 0, Some(10)),
            None,
            "nothing is that old: nothing to confirm"
        );
        assert_eq!(retention_confirm(Keep::Forever, 99, 5, Some(400)), None, "Forever deletes nothing");
        let q = retention_confirm(Keep::Days(30), 2, 1_500, Some(40)).unwrap();
        assert!(q.contains("2 recorded events and 1,500 per-minute input tallies"), "{q}");
        assert!(
            retention_confirm(Keep::Days(30), 0, 7, None).is_some(),
            "tallies alone are worth a question"
        );
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_000), "1,000");
        assert_eq!(thousands(1_234_567), "1,234,567");
    }

    #[test]
    fn the_settings_boxes_become_the_writes_config_set_would_make() {
        let plan = plan_settings("90 days", " 300 ").unwrap();
        assert_eq!(
            plan,
            SettingsPlan {
                keep: Keep::Days(90),
                idle_secs: 300
            }
        );
        assert_eq!(
            settings_writes(&plan),
            vec![
                ("retention.events", "90".to_string()),
                ("retention.input_buckets", "90".to_string()),
                ("idle_threshold_secs", "300".to_string()),
            ]
        );
        assert!(
            plan_settings("Forever", "two minutes")
                .unwrap_err()
                .contains("whole number of seconds")
        );
        assert!(plan_settings("0", "120").is_err());
        // Every key the plan writes is one `config set` knows.
        for (key, _) in settings_writes(&plan) {
            assert!(crate::config::KEYS.iter().any(|(k, _)| *k == key), "{key}");
        }
    }

    #[test]
    fn the_apps_list_is_the_uncategorised_ones_without_our_own_programs() {
        let cat = Catalogue::new(&Default::default(), &[]);
        let totals = vec![
            ("rhen-watchw.exe".to_string(), 9_999_999),
            ("rhen-watch.exe".to_string(), 9_999_998),
            ("lockapp.exe".to_string(), 9_999_997),
            ("zzz-unknown.exe".to_string(), 7_200_000),
            ("aaa-unknown.exe".to_string(), 60_000),
            ("code.exe".to_string(), 5_000_000),
        ];
        let rows = app_rows(&totals, &cat);
        let names: Vec<&str> = rows.iter().map(|r| r.exe.as_str()).collect();
        assert!(names.contains(&"zzz-unknown.exe") && names.contains(&"aaa-unknown.exe"));
        assert!(
            !names.contains(&"rhen-watchw.exe") && !names.contains(&"rhen-watch.exe"),
            "{names:?}"
        );
        assert_eq!(names[0], "zzz-unknown.exe", "longest first");
        assert_eq!(rows[0].label(), "zzz-unknown.exe    2h 00m");
        // Past the old 15-line limit of the command line.
        let many: Vec<(String, i64)> = (0..60).map(|i| (format!("unknown{i:02}.exe"), 1_000 + i)).collect();
        assert_eq!(app_rows(&many, &cat).len(), 60);
        let lots: Vec<(String, i64)> = (0..300).map(|i| (format!("unknown{i:03}.exe"), 1_000 + i)).collect();
        assert_eq!(app_rows(&lots, &cat).len(), APPS_LIMIT);
    }

    #[test]
    fn the_category_box_lists_each_category_in_use_once() {
        let entries = vec![
            ("a.exe".to_string(), "work".to_string(), "default"),
            ("b.exe".to_string(), "editor".to_string(), "file"),
            ("c.exe".to_string(), "work".to_string(), "default"),
        ];
        assert_eq!(categories_in_use(&entries), ["editor", "work"]);
    }

    #[test]
    fn our_own_programs_are_part_of_the_shell_so_they_are_never_recorded_as_activity() {
        for exe in ["rhen-watchw.exe", "rhen-watch.exe"] {
            assert!(crate::categories::is_shell_window("anyclass", Some(exe)), "{exe}");
        }
    }
}
