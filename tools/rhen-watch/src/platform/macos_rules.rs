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

/// The launchd label and the app's bundle id. Generic, so it names no person or organisation.
pub const LABEL: &str = "org.openrhen.rhen-watch";

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `Info.plist` for the installed app: a menu bar app (`LSUIElement`, no Dock icon), macOS 13 or later.
pub fn info_plist(version: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>{LABEL}</string>
  <key>CFBundleName</key><string>rhen-watch</string>
  <key>CFBundleExecutable</key><string>rhen-watch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>{v}</string>
  <key>CFBundleVersion</key><string>{v}</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
"#,
        v = xml_escape(version)
    )
}

/// The LaunchAgent: start at login in the user's graphical session, restart after a crash (not after a clean
/// stop or Quit, which exit 0), at most once every 30 s, output to the log in the data folder. The data folder
/// is pinned so the agent records where `install` checked the config.
pub fn launch_agent_plist(program: &str, data_dir: &str, home: &str) -> String {
    let (program, data_dir, home) = (xml_escape(program), xml_escape(data_dir), xml_escape(home));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{program}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>WorkingDirectory</key><string>{data_dir}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>{home}</string><key>RHEN_WATCH_DIR</key><string>{data_dir}</string></dict>
  <key>StandardOutPath</key><string>{data_dir}/launchd.log</string>
  <key>StandardErrorPath</key><string>{data_dir}/launchd.log</string>
</dict>
</plist>
"#
    )
}

/// Where `install` links the command, so `rhen-watch` works in Terminal without the long path. A per-user
/// folder: `/usr/local/bin` would need sudo.
pub const BIN_DIR: &str = ".local/bin";

const PATH_BLOCK_START: &str = "# >>> rhen-watch: add ~/.local/bin to PATH >>>";
const PATH_BLOCK_END: &str = "# <<< rhen-watch <<<";

/// True when `dir` is one of the `:`-separated entries of `path` (a trailing `/` is ignored).
pub fn path_has(path: &str, dir: &str) -> bool {
    let want = dir.trim_end_matches('/');
    path.split(':').any(|p| !p.is_empty() && p.trim_end_matches('/') == want)
}

/// The shell start-up file to add the PATH line to, from the login shell in `$SHELL`: zsh (the macOS
/// default, and the fallback) reads `.zprofile`, bash `.bash_profile`. Other shells get `None` and a hint.
pub fn profile_for_shell(shell: Option<&str>) -> Option<&'static str> {
    let name = shell.and_then(|s| s.rsplit('/').next()).unwrap_or("zsh");
    match name {
        "" | "zsh" | "sh" => Some(".zprofile"),
        "bash" => Some(".bash_profile"),
        _ => None,
    }
}

/// `text` with the rhen-watch PATH block appended, or `None` when it is already there.
pub fn add_path_block(text: &str) -> Option<String> {
    if text.contains(PATH_BLOCK_START) {
        return None;
    }
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(PATH_BLOCK_START);
    out.push_str("\nexport PATH=\"$HOME/.local/bin:$PATH\"\n");
    out.push_str(PATH_BLOCK_END);
    out.push('\n');
    Some(out)
}

/// `text` without the rhen-watch PATH block (every copy), or `None` when there is none or it has no end line.
/// Nothing else changes.
pub fn remove_path_block(text: &str) -> Option<String> {
    if !text.contains(PATH_BLOCK_START) {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut inside = false;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if !inside && bare == PATH_BLOCK_START {
            inside = true;
        } else if inside {
            if bare == PATH_BLOCK_END {
                inside = false;
            }
        } else {
            out.push_str(line);
        }
    }
    // A start line with no end line was edited by hand: leave the file alone rather than cut the rest of it.
    if inside { None } else { Some(out) }
}
