// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! Broker control-plane client for the data plane.
//!
//! The data plane is a broker-supervised worker. It speaks newline-delimited
//! JSON-RPC 2.0 over stdio to `nvpair-ui-broker` and subscribes to the
//! notifications it needs for stage-two placement:
//!
//! - live per-node model inventory (capability gate input),
//! - scheduler ordering (`schedule:priority` fanned out by the broker),
//! - node telemetry / coarse GPU pressure,
//! - manual pin from the TUI (honored only within the candidate set),
//! - `lan.endpoint.updated` from `yardmaster-lan-scanner` (promoted LAN targets).
//!
//! It never sends inference here; this is control plane only.

#![forbid(unsafe_code)]

/// A broker notification the data plane consumes.
#[derive(Debug, Clone)]
pub enum ControlEvent {
    InventoryUpdated,
    SchedulerOrdering,
    NodeTelemetry,
    ManualPin,
    LanEndpointUpdated,
}
