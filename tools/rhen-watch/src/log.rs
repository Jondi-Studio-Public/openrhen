//! A tiny log: stderr when there is a console, and always a file in the data folder, because the
//! no-console build has nowhere else to say what went wrong. One file, rotated at 1 MB.

use std::io::Write;

const MAX_BYTES: u64 = 1_000_000;

/// `2026-11-09T14:03:12+13:00`: local time with its offset, so a log line can be matched to the report.
pub fn stamp(utc_ms: i64, offset_min: i32) -> String {
    let local = utc_ms.div_euclid(1000) + i64::from(offset_min) * 60;
    let (y, m, d) = crate::cli::civil_from_days(local.div_euclid(86_400));
    let s = local.rem_euclid(86_400);
    let sign = if offset_min < 0 { '-' } else { '+' };
    let a = offset_min.abs();
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}{sign}{:02}:{:02}",
        s / 3600,
        (s % 3600) / 60,
        s % 60,
        a / 60,
        a % 60
    )
}

fn write(level: &str, msg: &str) {
    let now = crate::cli::now_ms();
    let when = stamp(now, crate::cli::local_tz().offset_at(now));
    let line = format!("{when} {level} {msg}\n");
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
