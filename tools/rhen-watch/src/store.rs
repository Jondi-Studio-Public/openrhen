//! Local append-only store. Rows are inserted and intervals are closed; nothing is rewritten except by
//! the retention purge, which the config controls and which defaults to keeping everything.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::model::{Ms, Op};

const SCHEMA_VERSION: i64 = 1;

/// An interval that has started and not ended. Held in memory and mirrored to `meta.open_state` in the
/// same transaction as every batch, so rows in `events` are written once, complete, and never changed.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct OpenIv {
    pub id: String,
    pub source: String,
    pub kind: String,
    pub ts_start: Ms,
    pub attrs: serde_json::Map<String, Value>,
}

pub struct Store {
    conn: Connection,
    open: std::collections::BTreeMap<String, OpenIv>,
    /// Makes instant ids unique without scanning the table.
    salt: u64,
    seq: u64,
    #[cfg(test)]
    pub fail_next: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventRow {
    pub id: String,
    pub ts_start: Ms,
    pub ts_end: Option<Ms>,
    pub source: String,
    pub kind: String,
    pub attrs: Value,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MetricRow {
    pub minute_ts: Ms,
    pub cpu_ms: i64,
    pub rss_bytes: i64,
    pub db_bytes: i64,
    pub events: i64,
    pub dropped: i64,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // FULL is not needed for an activity log; NORMAL in WAL cannot corrupt, it can lose the last moments.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Self::init(conn)
    }

    /// For `report` and `status`: never writes, creates nothing, so it cannot contend with a running agent.
    pub fn open_read_only(path: &Path) -> rusqlite::Result<Self> {
        use rusqlite::OpenFlags;
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut store = Self::bare(conn);
        if let Some(json) = store.meta("open_state")? {
            let list: Vec<OpenIv> = serde_json::from_str(&json).unwrap_or_default();
            store.open = list.into_iter().map(|o| (o.id.clone(), o)).collect();
        }
        Ok(store)
    }

    fn bare(conn: Connection) -> Self {
        use std::hash::{BuildHasher, Hasher};
        let salt = std::collections::hash_map::RandomState::new().build_hasher().finish();
        Self {
            conn,
            open: Default::default(),
            salt,
            seq: 0,
            #[cfg(test)]
            fail_next: 0,
        }
    }

    /// Fold the write-ahead log back into the database file, so purged rows leave it.
    pub fn checkpoint(&self) -> rusqlite::Result<()> {
        self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS events (
               id       TEXT PRIMARY KEY,
               device   TEXT NOT NULL,
               ts_start INTEGER NOT NULL,
               ts_end   INTEGER NOT NULL,
               source   TEXT NOT NULL,
               kind     TEXT NOT NULL,
               attrs    TEXT NOT NULL DEFAULT '{}'
             );
             CREATE INDEX IF NOT EXISTS events_by_start ON events (ts_start);
             CREATE TABLE IF NOT EXISTS metrics (
               minute_ts INTEGER PRIMARY KEY,
               cpu_ms    INTEGER NOT NULL,
               rss_bytes INTEGER NOT NULL,
               db_bytes  INTEGER NOT NULL,
               events    INTEGER NOT NULL,
               dropped   INTEGER NOT NULL
             );",
        )?;
        conn.pragma_update(None, "secure_delete", "ON")?;
        let mut store = Self::bare(conn);
        if let Some(json) = store.meta("open_state")? {
            let list: Vec<OpenIv> = serde_json::from_str(&json).unwrap_or_default();
            store.open = list.into_iter().map(|o| (o.id.clone(), o)).collect();
        }
        let version: Option<i64> = store
            .conn
            .query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get::<_, String>(0))
            .optional()?
            .and_then(|v| v.parse().ok());
        match version {
            None => store.set_meta("schema_version", &SCHEMA_VERSION.to_string())?,
            Some(v) if v > SCHEMA_VERSION => {
                return Err(rusqlite::Error::InvalidParameterName(format!(
                    "database schema {v} is newer than this build ({SCHEMA_VERSION})"
                )));
            }
            Some(_) => {}
        }
        Ok(store)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn meta(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key=?1", params![key], |r| r.get(0))
            .optional()
    }

    /// Apply a batch in one transaction, together with the open-interval state and the heartbeat `now`.
    pub fn apply(&mut self, device: &str, ops: &[Op], now: Ms) -> rusqlite::Result<()> {
        #[cfg(test)]
        if self.fail_next > 0 {
            self.fail_next -= 1;
            return Err(rusqlite::Error::InvalidQuery);
        }
        let instant_ids: Vec<String> = ops
            .iter()
            .map(|op| match op {
                Op::Instant { source, kind, ts, .. } => self.next_instant_id(*ts, source, kind),
                _ => String::new(),
            })
            .collect();
        let tx = self.conn.transaction()?;
        let mut open = self.open.clone();
        for (op, instant_id) in ops.iter().zip(instant_ids) {
            match op {
                Op::Open {
                    id,
                    source,
                    kind,
                    ts,
                    attrs,
                } => {
                    open.insert(
                        id.clone(),
                        OpenIv {
                            id: id.clone(),
                            source: (*source).into(),
                            kind: kind.clone(),
                            ts_start: *ts,
                            attrs: attrs.clone(),
                        },
                    );
                }
                Op::Close { id, ts } => {
                    if let Some(iv) = open.remove(id) {
                        insert_row(&tx, device, &iv, (*ts).max(iv.ts_start))?;
                    }
                }
                Op::Instant {
                    source,
                    kind,
                    ts,
                    end,
                    attrs,
                } => {
                    let iv = OpenIv {
                        id: instant_id,
                        source: (*source).into(),
                        kind: kind.clone(),
                        ts_start: *ts,
                        attrs: attrs.clone(),
                    };
                    insert_row(&tx, device, &iv, end.unwrap_or(*ts).max(*ts))?;
                }
            }
        }
        let list: Vec<&OpenIv> = open.values().collect();
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('open_state', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())],
        )?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('last_heartbeat', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![now.to_string()],
        )?;
        tx.commit()?;
        self.open = open;
        Ok(())
    }

    fn next_instant_id(&mut self, ts: Ms, source: &str, kind: &str) -> String {
        self.seq += 1;
        format!("{:013x}-{source}-{kind}-{:08x}{:x}", ts.max(0), self.salt as u32, self.seq)
    }

    pub fn last_heartbeat(&self) -> rusqlite::Result<Option<Ms>> {
        Ok(self.meta("last_heartbeat")?.and_then(|v| v.parse().ok()))
    }

    /// Intervals still open, as rows with no end (the live ones of a running agent).
    pub fn open_rows(&self) -> Vec<EventRow> {
        self.open
            .values()
            .map(|o| EventRow {
                id: o.id.clone(),
                ts_start: o.ts_start,
                ts_end: None,
                source: o.source.clone(),
                kind: o.kind.clone(),
                attrs: Value::Object(o.attrs.clone()),
            })
            .collect()
    }

    /// At start: close whatever a crash or sleep left open at the last heartbeat, and record the time the
    /// agent was not running as `unknown`. Returns the gap, if one was recorded.
    pub fn recover(&mut self, device: &str, now: Ms) -> rusqlite::Result<Option<(Ms, Ms)>> {
        let Some(last) = self.last_heartbeat()? else {
            return Ok(None);
        };
        let ids: Vec<String> = self.open.keys().cloned().collect();
        let mut ops: Vec<Op> = ids.into_iter().map(|id| Op::Close { id, ts: last }).collect();
        let gap = now - last > 10_000;
        if gap {
            ops.push(Op::Instant {
                source: crate::model::SRC_AGENT,
                kind: "unknown".into(),
                ts: last,
                end: Some(now),
                attrs: crate::model::attrs([("reason", Value::from("agent not running"))]),
            });
        }
        self.apply(device, &ops, now)?;
        Ok(gap.then_some((last, now)))
    }

    pub fn put_metric(&self, m: &MetricRow) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO metrics (minute_ts, cpu_ms, rss_bytes, db_bytes, events, dropped) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(minute_ts) DO UPDATE SET cpu_ms=excluded.cpu_ms, rss_bytes=MAX(rss_bytes, excluded.rss_bytes),
               db_bytes=excluded.db_bytes, events=events+excluded.events, dropped=dropped+excluded.dropped",
            params![m.minute_ts, m.cpu_ms, m.rss_bytes, m.db_bytes, m.events, m.dropped],
        )?;
        Ok(())
    }

    pub fn metrics_between(&self, from: Ms, to: Ms) -> rusqlite::Result<Vec<MetricRow>> {
        let mut stmt = self.conn.prepare("SELECT minute_ts, cpu_ms, rss_bytes, db_bytes, events, dropped FROM metrics WHERE minute_ts >= ?1 AND minute_ts < ?2 ORDER BY minute_ts")?;
        let rows = stmt.query_map(params![from, to], |r| {
            Ok(MetricRow {
                minute_ts: r.get(0)?,
                cpu_ms: r.get(1)?,
                rss_bytes: r.get(2)?,
                db_bytes: r.get(3)?,
                events: r.get(4)?,
                dropped: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Events that overlap `[from, to)`; open intervals count as running to `open_until`.
    pub fn events_between(&self, from: Ms, to: Ms) -> rusqlite::Result<Vec<EventRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ts_start, ts_end, source, kind, attrs FROM events
             WHERE ts_start < ?2 AND ts_end >= ?1 ORDER BY ts_start, id",
        )?;
        let rows = stmt.query_map(params![from, to], |r| {
            let attrs: String = r.get(5)?;
            Ok(EventRow {
                id: r.get(0)?,
                ts_start: r.get(1)?,
                ts_end: Some(r.get(2)?),
                source: r.get(3)?,
                kind: r.get(4)?,
                attrs: serde_json::from_str(&attrs).unwrap_or(Value::Null),
            })
        })?;
        rows.collect()
    }

    /// (exe, milliseconds in front) over everything stored, for `categories list --uncategorised`.
    pub fn app_time_totals(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT json_extract(attrs, '$.exe'), SUM(ts_end - ts_start) FROM events
             WHERE source = 'foreground' AND kind = 'app' GROUP BY 1",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, Option<String>>(0)?.unwrap_or_default(), r.get::<_, i64>(1)?))
        })?;
        rows.collect()
    }

    pub fn count_events(&self) -> rusqlite::Result<i64> {
        self.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
    }

    /// Delete events that ended before `cutoff`. Open intervals are not in the table, so are never purged.
    pub fn purge_events_before(&self, cutoff: Ms) -> rusqlite::Result<usize> {
        self.conn.execute("DELETE FROM events WHERE ts_end < ?1", params![cutoff])
    }

    pub fn purge_metrics_before(&self, cutoff: Ms) -> rusqlite::Result<usize> {
        self.conn.execute("DELETE FROM metrics WHERE minute_ts < ?1", params![cutoff])
    }

    pub fn db_bytes(&self) -> i64 {
        let pages: i64 = self.conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
        let size: i64 = self.conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap_or(0);
        pages * size
    }
}

fn insert_row(tx: &rusqlite::Transaction, device: &str, iv: &OpenIv, end: Ms) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT OR IGNORE INTO events (id, device, ts_start, ts_end, source, kind, attrs) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            iv.id,
            device,
            iv.ts_start,
            end,
            iv.source,
            iv.kind,
            Value::Object(iv.attrs.clone()).to_string()
        ],
    )?;
    Ok(())
}
