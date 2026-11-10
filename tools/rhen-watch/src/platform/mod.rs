#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub mod macos_install;
pub mod macos_rules;
#[cfg(target_os = "macos")]
pub mod macos_run;
#[cfg(windows)]
pub mod windows;
#[cfg(windows)]
pub mod windows_app;
#[cfg(windows)]
pub mod windows_install;
#[cfg(windows)]
pub mod windows_shortcut;
