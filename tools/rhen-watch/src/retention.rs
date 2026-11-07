//! Purge according to config. Permanent (the default) deletes nothing.

use crate::config::Config;
use crate::model::Ms;
use crate::store::Store;

const DAY_MS: i64 = 86_400_000;

/// Returns (events deleted, metrics deleted).
pub fn purge(store: &Store, cfg: &Config, now: Ms) -> Result<(usize, usize), String> {
    let mut events = 0;
    let mut metrics = 0;
    if let Some(days) = cfg.retention.events.days()? {
        events = store
            .purge_events_before(now - i64::from(days) * DAY_MS)
            .map_err(|e| e.to_string())?;
    }
    if let Some(days) = cfg.retention.metrics.days()? {
        metrics = store
            .purge_metrics_before(now - i64::from(days) * DAY_MS)
            .map_err(|e| e.to_string())?;
    }
    Ok((events, metrics))
}
