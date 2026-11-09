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
