// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! Metrics: a first-class subsystem, not a `/metrics` endpoint bolted on.
//!
//! Every request produces exactly one structured event at completion or abort.
//! The event carries routing, placement, token, latency, cost, and locality
//! fields — and **never** prompt or completion text, and no headers other
//! than `content-type` / `content-length`. Events are appended to a local
//! SQLite database (WAL) in PAIR's data directory with tables `events`,
//! `rollups_hourly`, `cost_daily`; created 0600 / user-only ACL. Peer events
//! replicate over PAIR's existing mTLS workload port.
//!
//! Exposure: Prometheus on `:4000/metrics` (bounded labels; never a request id
//! or address as a label), optional OTLP (HTTPS or loopback only), and the
//! `metrics.query` / `metrics.report` / `metrics.export` / `metrics.ingest`
//! JSON-RPC methods. `yardmaster report --from --to --out` produces the same
//! Markdown document without the UI.

#![forbid(unsafe_code)]

/// The metrics event. Field set is frozen by an allowlist test (spec section 4
/// and 6): adding a field requires updating the allowlist and the schema doc.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MetricsEvent {
    pub request_id: String,
    pub client_ingress_protocol: String,
    pub client_ingress_port: u16,
    /// Loopback PID where the OS permits, else the connecting address. Never a
    /// full remote address beyond loopback classification in the stored row.
    pub client_identity: String,
    pub route: String,
    pub algorithm: String,
    pub tier_decided: String,
    pub decision_reason: String,
    pub candidate_set_size: u32,
    pub node_or_provider: String,
    pub failover_count: u32,
    pub engine_kind: String,
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: Option<u64>,
    pub time_to_first_token_ms: Option<u64>,
    pub total_latency_ms: u64,
    /// Time inside Yardmaster, excluding upstream.
    pub routing_overhead_ms: u64,
    pub judge_latency_ms: Option<u64>,
    pub judge_tokens: Option<u64>,
    pub stream: bool,
    pub http_status: u16,
    pub error_class: Option<String>,
    pub estimated_cost_usd: f64,
    pub locality: String,
    // Harness correlation (spec 1.10). Present when the request came from dsh.
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub step_id: Option<String>,
    pub tier_rule: Option<String>,
}
