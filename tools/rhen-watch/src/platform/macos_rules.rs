//! The macOS layer's decisions as pure functions, so they are tested on any OS. `macos.rs` does the FFI and
//! calls these.

use crate::engine::PowerEvt;

/// The identity recorded for an app: its bundle identifier when it has one (stable across renames and
/// languages), else its executable file name, lower-cased either way. `None` when the OS gave neither, which
/// the engine records as a refused lookup rather than guessing.
pub fn identity(bundle_id: Option<&str>, executable_path: Option<&str>) -> Option<String> {
    let bundle = bundle_id.map(str::trim).filter(|b| !b.is_empty());
    if let Some(b) = bundle {
        return Some(b.to_lowercase());
    }
    let exe = executable_path?.rsplit('/').find(|part| !part.is_empty())?.trim();
    (!exe.is_empty()).then(|| exe.to_lowercase())
}

/// The value `IOPSGetProvidingPowerSourceType` returns, mapped to a power event. A UPS counts as battery: the
/// machine is no longer on mains. Anything else is unknown and sends nothing.
pub fn power_source(kind: &str) -> Option<PowerEvt> {
    match kind {
        "AC Power" => Some(PowerEvt::Ac),
        "Battery Power" | "UPS Power" => Some(PowerEvt::Battery),
        _ => None,
    }
}

/// The power-source callback fires on every change of charge, not only on plugging in, so only a change of
/// source is passed on.
#[derive(Debug, Default)]
pub struct PowerDedupe {
    last: Option<PowerEvt>,
}

impl PowerDedupe {
    pub const fn new() -> Self {
        Self { last: None }
    }

    pub fn changed(&mut self, now: Option<PowerEvt>) -> Option<PowerEvt> {
        let now = now?;
        if self.last.as_ref() == Some(&now) {
            return None;
        }
        self.last = Some(now.clone());
        Some(now)
    }
}

/// The running agent writes its process id into `run.lock`. Anything else in the file means no agent.
pub fn pid_from_lock(text: &str) -> Option<i32> {
    let pid: i32 = text.trim().parse().ok()?;
    (pid > 1).then_some(pid)
}

/// `stop` signals a process only if its executable is a rhen-watch binary; a reused pid belonging to anything
/// else is left alone.
pub fn is_agent_path(path: &str) -> bool {
    path.rsplit('/').next() == Some("rhen-watch")
}

/// Apps that are part of the system's own interface. Their coming to the front does not end the real app's
/// interval (the counterpart of the Windows taskbar and task switcher). The login window comes to the front
/// while the screen is locked; that time is the lock's, recorded by the lock notification.
pub const SHELL_BUNDLES: &[&str] = &[
    "com.apple.loginwindow",
    "com.apple.dock",
    "com.apple.systemuiserver",
    "com.apple.notificationcenterui",
    "com.apple.controlcenter",
    "com.apple.spotlight",
    "com.apple.wallpaper.agent",
    "com.apple.screensaver.engine",
];

pub fn is_shell_bundle(id: &str) -> bool {
    SHELL_BUNDLES.contains(&id)
}
