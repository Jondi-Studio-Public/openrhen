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
    /// Open the data folder in Explorer. It holds `config.toml` and `categories.toml`, so it is also the
    /// settings. A user-clicked action that touches no other app.
    OpenDataFolder,
    Quit,
    None,
}

pub fn action_for(id: usize) -> TrayAction {
    match id {
        ID_TOGGLE => TrayAction::TogglePause,
        ID_FOLDER | ID_SETTINGS => TrayAction::OpenDataFolder,
        ID_QUIT => TrayAction::Quit,
        _ => TrayAction::None,
    }
}

/// Which built-in icon the tray shows.
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
