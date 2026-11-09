//! Getting data out (`export`) and getting it all off the machine (`wipe`, `uninstall --purge`).

use std::path::{Path, PathBuf};

use crate::store::Store;

/// A consistent single-file copy of the database, made with `VACUUM INTO` through a read-only connection, so it is
/// safe while the agent records (copying `activity.db` alone would leave out what is still in the -wal file).
/// Refuses to overwrite. Returns the size of the copy in bytes.
pub fn export_db(db: &Path, dest: &Path) -> Result<u64, String> {
    if dest.exists() {
        return Err(format!("{} already exists; choose a new file name", dest.display()));
    }
    if !db.exists() {
        return Err("no database yet; run `rhen-watch run` first".into());
    }
    let store = Store::open_read_only(db).map_err(|e| e.to_string())?;
    // Claim the name first: VACUUM INTO accepts an empty file, and on failure we then delete only a file
    // this call created, never one another process put there after the check above.
    match std::fs::OpenOptions::new().write(true).create_new(true).open(dest) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(format!("{} already exists; choose a new file name", dest.display()));
        }
        Err(e) => return Err(format!("cannot write {}: {e}", dest.display())),
    }
    if let Err(e) = store.vacuum_into(dest) {
        let _ = std::fs::remove_file(dest);
        return Err(format!("cannot write {}: {e}", dest.display()));
    }
    std::fs::metadata(dest).map(|m| m.len()).map_err(|e| e.to_string())
}

/// Everything rhen-watch keeps in its data folder, sidecar files before the database they belong to.
const OWNED: [&str; 11] = [
    "activity.db-wal",
    "activity.db-shm",
    "activity.db",
    "config.toml",
    "categories.toml",
    "categories.toml.tmp",
    "run.lock",
    "rhen-watch.log",
    "rhen-watch.log.1",
    "restart-reason.txt",
    "not-starting.txt",
];

/// Delete those files (stopping at the first one that cannot go, which is what a running agent causes) and, with
/// `remove_dir`, the folder too when nothing else is in it. Files the user added are kept. Returns what was deleted.
/// The log goes last and nothing may log afterwards, so callers print to the console only.
pub fn wipe_files(dir: &Path, remove_dir: bool) -> Result<Vec<PathBuf>, String> {
    let mut gone = Vec::new();
    for name in OWNED {
        let p = dir.join(name);
        match std::fs::remove_file(&p) {
            Ok(()) => gone.push(p),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "could not delete {}: {e} (is the agent running? use `rhen-watch stop` first)",
                    p.display()
                ));
            }
        }
    }
    if remove_dir {
        // Fails, and is ignored, when the folder is not empty.
        let _ = std::fs::remove_dir(dir);
    }
    Ok(gone)
}
