//! Device-generated event ids: sortable by time, unique per device, made before any future upload so a
//! retry cannot duplicate a row.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};

use crate::model::Ms;

pub fn generator(clock: impl Fn() -> Ms + Send + 'static) -> Box<dyn FnMut() -> String + Send> {
    let state = RandomState::new();
    let mut counter: u64 = 0;
    Box::new(move || {
        counter += 1;
        let mut h = state.build_hasher();
        h.write_u64(counter);
        h.write_i64(clock());
        format!("{:013x}{:016x}", clock().max(0), h.finish())
    })
}

/// A random-looking device id, made once and stored in the database.
pub fn device_id() -> String {
    let state = RandomState::new();
    let mut h = state.build_hasher();
    h.write_u64(std::process::id() as u64);
    format!("dev-{:016x}", h.finish())
}
