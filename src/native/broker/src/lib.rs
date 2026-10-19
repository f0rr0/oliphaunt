#![doc = include_str!("../README.md")]
//! Broker transport shared by the broker executable and native SDK client.
pub mod config;
pub mod exchange;
pub mod ipc;
pub mod mobile;
pub mod pgwire;
