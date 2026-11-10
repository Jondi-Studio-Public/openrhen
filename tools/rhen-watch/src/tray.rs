//! The tray menu's commands as pure data, so the id -> action mapping is tested on any OS. The Windows layer
//! builds the menu and performs the action.

pub const ID_STATUS: usize = 1;
pub const ID_TOGGLE: usize = 2;
pub const ID_FOLDER: usize = 3;
pub const ID_QUIT: usize = 4;
pub const ID_SETTINGS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TrayAction {
    TogglePause,
    /// Open the settings window (`rhen-watchw.exe app`), or bring the open one to the front.
    OpenApp,
    /// Open the data folder in Explorer. A user-clicked action that touches no other app.
    OpenDataFolder,
    Quit,
    None,
}

pub fn action_for(id: usize) -> TrayAction {
    match id {
        ID_TOGGLE => TrayAction::TogglePause,
        ID_SETTINGS => TrayAction::OpenApp,
        ID_FOLDER => TrayAction::OpenDataFolder,
        ID_QUIT => TrayAction::Quit,
        _ => TrayAction::None,
    }
}

/// Offsets from `WM_APP` of the agent window's own private messages. The settings window's control message is a
/// registered one (`app_model::CONTROL_MESSAGE_NAME`), which Windows numbers from 0xC000 up, so it cannot be one of
/// these (tested in `app_model`).
pub const TRAY_MSG_OFFSET: u32 = 1;
pub const TRAY_REFRESH_MSG_OFFSET: u32 = 2;

/// Which icon the tray shows (the generated icons in `assets/`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TrayIcon {
    Recording,
    Paused,
    Degraded,
}

/// The icon for a runner state (`recording`, `paused` or a `degraded` name).
pub fn icon_for(state: &str) -> TrayIcon {
    if state == "paused" {
        TrayIcon::Paused
    } else if state.starts_with("degraded") {
        TrayIcon::Degraded
    } else {
        TrayIcon::Recording
    }
}

/// One balloon, when the state becomes degraded; none for a repeat or for recovery.
pub fn should_balloon(before: &str, now: &str) -> bool {
    icon_for(now) == TrayIcon::Degraded && icon_for(before) != TrayIcon::Degraded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_state_has_its_own_icon() {
        let icons = [icon_for("recording"), icon_for("paused"), icon_for("degraded (writes are failing)")];
        assert_eq!(icons, [TrayIcon::Recording, TrayIcon::Paused, TrayIcon::Degraded]);
    }

    #[test]
    fn the_balloon_shows_once_when_the_state_becomes_degraded() {
        assert!(should_balloon("recording", "degraded"));
        assert!(should_balloon("paused", "degraded (writes are failing)"));
        assert!(!should_balloon("degraded", "degraded"));
        assert!(!should_balloon("degraded", "recording"));
        assert!(!should_balloon("recording", "paused"));
    }
}
