//! The same program without a console window. Start-at-logon launches this one, so no black window
//! appears; errors go to the log file in the data folder, and a `run` that fails before it is recording
//! also shows them in a message box.
#![cfg_attr(windows, windows_subsystem = "windows")]
fn main() {
    rhen_watch::cli::main_windowless();
}
