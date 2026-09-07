// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! The metrics store schema as data: the migration SQL and the column
//! allowlists that `tests/schema_allowlist.rs` checks it against.
//!
//! The **allowlist is the guard**: any column in `migrations/0001_init.sql`
//! that is not named here fails the test, so a `prompt_text` column cannot be
//! added by touching only the SQL. The `FORBIDDEN_NAME_FRAGMENTS` list is a
//! second signal for reviewers.

/// The v1 migration, embedded so the store needs no files at runtime.
pub const MIGRATION_V1: &str = include_str!("../migrations/0001_init.sql");

/// Every column allowed in `events`. Order matches the migration.
pub const EVENT_COLUMNS: &[&str] = &[
    "request_id",
    "ts_ms",
    "client_ingress_protocol",
    "client_ingress_port",
    "client_identity",
    "route",
    "algorithm",
    "tier_decided",
    "decision_reason",
    "rule",
    "candidate_set_size",
    "node_or_provider",
    "failover_count",
    "engine_kind",
    "model",
    "prompt_tokens",
    "completion_tokens",
    "cached_tokens",
    "time_to_first_token_ms",
    "total_latency_ms",
    "routing_overhead_ms",
    "judge_latency_ms",
    "judge_tokens",
    "stream",
    "http_status",
    "error_class",
    "estimated_cost_usd",
    "locality",
    "session_id",
    "agent_id",
    "step_id",
    "tier_rule",
];

/// Every column allowed in `rollups_hourly`.
pub const ROLLUP_COLUMNS: &[&str] = &[
    "hour_start_ms",
    "route",
    "tier",
    "engine_kind",
    "model",
    "provider",
    "locality",
    "status_class",
    "request_count",
    "prompt_tokens",
    "completion_tokens",
    "cached_tokens",
    "failover_count",
    "judge_calls",
    "error_count",
    "sum_latency_ms",
    "sum_ttft_ms",
    "sum_routing_overhead_ms",
    "sum_cost_usd",
    "p50_latency_ms",
    "p99_latency_ms",
];

/// Every column allowed in `cost_daily`.
pub const COST_COLUMNS: &[&str] = &[
    "day",
    "provider",
    "tier",
    "route",
    "model",
    "locality",
    "node",
    "tokens_in",
    "tokens_out",
    "request_count",
    "cost_usd",
];

/// Column-name fragments that would signal content capture. A column whose name
/// contains any of these fails the schema test regardless of the allowlist.
/// `prompt_tokens` / `completion_tokens` are counts and are allowed; the
/// fragments below never appear in a legitimate column name.
pub const FORBIDDEN_NAME_FRAGMENTS: &[&str] = &[
    "prompt_text",
    "completion_text",
    "message",
    "content",
    "body",
    "response_text",
    "header",
    "remote_addr",
    "client_ip",
    "ip_addr",
    "user_agent",
    "authorization",
    "api_key",
    "secret",
    "token_value",
];

/// Table name -> its allowlist.
pub fn allowlist_for(table: &str) -> Option<&'static [&'static str]> {
    match table {
        "events" => Some(EVENT_COLUMNS),
        "rollups_hourly" => Some(ROLLUP_COLUMNS),
        "cost_daily" => Some(COST_COLUMNS),
        "schema_version" => Some(&["version"]),
        _ => None,
    }
}
