//! The event vocabulary shared by the engine, the store and the report.

use serde_json::{Map, Value};

/// Milliseconds since the Unix epoch, UTC.
pub type Ms = i64;

pub const SRC_FOREGROUND: &str = "foreground";
pub const SRC_IDLE: &str = "idle";
pub const SRC_SESSION: &str = "session";
pub const SRC_POWER: &str = "power";
pub const SRC_AGENT: &str = "agent";

/// What the engine asks the store to do. Everything the agent knows is one of these.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// An interval has started; `ts_end` stays empty until `Close`.
    Open {
        id: String,
        source: &'static str,
        kind: String,
        ts: Ms,
        attrs: Map<String, Value>,
    },
    Close {
        id: String,
        ts: Ms,
    },
    /// A point event, or an interval whose end is already known.
    Instant {
        source: &'static str,
        kind: String,
        ts: Ms,
        end: Option<Ms>,
        attrs: Map<String, Value>,
    },
    /// The running tally of one minute for one exe in one run: an absolute upsert, so replaying it is harmless.
    /// Not an event: it goes to `input_buckets`, a tally table apart from the write-once `events`.
    Bucket {
        minute_ts: Ms,
        exe: String,
        run: u64,
        observed_ms: i64,
        input_ms: i64,
    },
    /// A value for the `meta` table, written in the same transaction as the ops around it.
    Meta {
        key: String,
        value: String,
    },
}

impl Op {
    /// True for the ops that become (or close) rows in `events`.
    pub fn is_event_op(&self) -> bool {
        !matches!(self, Op::Bucket { .. } | Op::Meta { .. })
    }
}

pub fn attrs<const N: usize>(pairs: [(&str, Value); N]) -> Map<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}
