//! rhen-watch: a local desktop activity recorder. Observation only; it sends nothing anywhere.
#![cfg_attr(not(windows), allow(dead_code))]

pub mod activity;
pub mod categories;
pub mod cli;
pub mod config;
pub mod derive;
pub mod engine;
pub mod handover;
pub mod ids;
pub mod log;
pub mod model;
pub mod paths;
pub mod platform;
pub mod report;
pub mod retention;
pub mod runner;
pub mod store;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_derive;
#[cfg(test)]
mod tests_kit;
#[cfg(test)]
mod tests_meter;
#[cfg(test)]
mod tests_offset;
#[cfg(test)]
mod tests_report;
#[cfg(test)]
mod tests_settings;
#[cfg(test)]
mod tests_tz;
pub mod tray;
pub mod tz;
