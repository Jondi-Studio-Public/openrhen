use std::path::{Path, PathBuf};

/// `RHEN_WATCH_DIR`, else `%LOCALAPPDATA%\rhen-watch` (Windows) or the XDG data dir elsewhere.
pub fn data_dir() -> Result<PathBuf, String> {
    if let Some(d) = std::env::var_os("RHEN_WATCH_DIR") {
        return Ok(PathBuf::from(d));
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|d| PathBuf::from(d).join("rhen-watch"))
            .ok_or_else(|| "LOCALAPPDATA is not set".to_string())
    }
    #[cfg(not(windows))]
    {
        if let Some(d) = std::env::var_os("XDG_DATA_HOME") {
            return Ok(PathBuf::from(d).join("rhen-watch"));
        }
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join(".local/share/rhen-watch"))
            .ok_or_else(|| "HOME is not set".to_string())
    }
}

/// The name of the event `rhen-watch stop` signals, one per data directory so a test agent started with
/// `RHEN_WATCH_DIR` is not stopped by (or stopping) the installed one. The suffix is a hash of the directory's
/// canonical path (its name as given while the directory does not exist yet), compared without regard to case.
pub fn stop_event_name(dir: &Path) -> String {
    let canonical = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    // FNV-1a, 64 bit: a fixed algorithm, so every build and both binaries agree on the name.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in canonical.to_string_lossy().to_ascii_lowercase().bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    format!("Local\\rhen-watch-stop-{h:016x}")
}

/// The one stop event name builds before the per-directory one listened on. Only `stop` still tries it, so an
/// agent installed by such a build can be stopped by an upgraded program; no agent creates it any more, so it
/// cannot reach across data directories. Remove it (and `stop_event_names`) after the first tagged release that ships
/// the per-directory name, since no agent installed before that can still be running by then.
pub const LEGACY_STOP_EVENT_NAME: &str = "Local\\rhen-watch-stop";

/// Every event name `stop` signals for this data directory: its own, then the legacy one.
pub fn stop_event_names(dir: &Path) -> [String; 2] {
    [stop_event_name(dir), LEGACY_STOP_EVENT_NAME.to_string()]
}
