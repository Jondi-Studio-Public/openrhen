//! A tiny log: stderr when there is a console, and always a file in the data folder, because the
//! no-console build has nowhere else to say what went wrong. One file, rotated at 1 MB.

use std::io::Write;

const MAX_BYTES: u64 = 1_000_000;

fn write(level: &str, msg: &str) {
    let now = crate::cli::now_ms();
    let line = format!("{now} {level} {msg}\n");
    let Ok(dir) = crate::paths::data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("rhen-watch.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join("rhen-watch.log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

pub fn info(msg: &str) {
    println!("{msg}");
    write("info", msg);
}

pub fn warn(msg: &str) {
    eprintln!("warning: {msg}");
    write("warn", msg);
}

pub fn error(msg: &str) {
    eprintln!("rhen-watch: {msg}");
    write("error", msg);
}
