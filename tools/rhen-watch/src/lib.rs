//! rhen-watch: a local desktop activity recorder. Observation only; it sends nothing anywhere.
#![cfg_attr(not(windows), allow(dead_code))]

pub mod categories;
pub mod cli;
pub mod config;
pub mod engine;
pub mod ids;
pub mod log;
pub mod model;
pub mod paths;
pub mod platform;
pub mod report;
pub mod retention;
pub mod runner;
pub mod store;
pub mod tz;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_tz;
