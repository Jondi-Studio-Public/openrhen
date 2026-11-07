use std::path::PathBuf;

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
