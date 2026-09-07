-- SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
-- SPDX-License-Identifier: Apache-2.0
--
-- Yardmaster metrics store, schema v1. SQLite (WAL), one file in PAIR's data
-- directory, created 0600 / user-only ACL (see docs/decisions/0012-metrics-store.md).
--
-- INVARIANT: no column holds prompt text, completion text, message content,
-- request/response bodies, arbitrary headers, or a full client address beyond a
-- loopback/non-loopback classification. `tests/schema_allowlist.rs` enforces
-- this against `src/schema.rs`. Adding a column means updating BOTH and the
-- table in docs/metrics.md.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One row per request, written at completion or abort.
CREATE TABLE IF NOT EXISTS events (
    request_id              TEXT    NOT NULL PRIMARY KEY,
    ts_ms                   INTEGER NOT NULL,               -- epoch millis, completion time
    client_ingress_protocol TEXT    NOT NULL,               -- ollama | openai_chat | openai_responses | anthropic_messages
    client_ingress_port     INTEGER NOT NULL,               -- 11434 | 1234 | 4000
    client_identity         TEXT    NOT NULL,               -- loopback PID where the OS permits, else "loopback"/"non-loopback"
    route                   TEXT    NOT NULL,
    algorithm               TEXT    NOT NULL,
    tier_decided            TEXT    NOT NULL,
    decision_reason         TEXT    NOT NULL,               -- signal name | judge verdict class | random | passthrough
    rule                    TEXT,                           -- plan_execute: the rule that fired
    candidate_set_size      INTEGER NOT NULL,
    node_or_provider        TEXT    NOT NULL,
    failover_count          INTEGER NOT NULL DEFAULT 0,
    engine_kind             TEXT    NOT NULL,               -- ollama | lmstudio | vllm | llamacpp | nim | openai_compatible | provider
    model                   TEXT    NOT NULL,
    prompt_tokens           INTEGER NOT NULL DEFAULT 0,
    completion_tokens       INTEGER NOT NULL DEFAULT 0,
    cached_tokens           INTEGER,
    time_to_first_token_ms  INTEGER,
    total_latency_ms        INTEGER NOT NULL,
    routing_overhead_ms     INTEGER NOT NULL,               -- time inside Yardmaster, excluding upstream
    judge_latency_ms        INTEGER,
    judge_tokens            INTEGER,
    stream                  INTEGER NOT NULL DEFAULT 0,     -- 0 | 1
    http_status             INTEGER NOT NULL,
    error_class             TEXT,
    estimated_cost_usd      REAL    NOT NULL DEFAULT 0,
    locality                TEXT    NOT NULL,               -- cluster | lan | remote
    -- DeepSeek Harness correlation (present only when the request came from dsh).
    session_id              TEXT,
    agent_id                TEXT,
    step_id                 TEXT,
    tier_rule               TEXT
);

CREATE INDEX IF NOT EXISTS events_ts       ON events (ts_ms);
CREATE INDEX IF NOT EXISTS events_route_ts ON events (route, ts_ms);
CREATE INDEX IF NOT EXISTS events_session  ON events (session_id) WHERE session_id IS NOT NULL;

-- Hourly rollups, kept 365 days (events themselves are pruned at retention_days).
CREATE TABLE IF NOT EXISTS rollups_hourly (
    hour_start_ms           INTEGER NOT NULL,
    route                   TEXT    NOT NULL,
    tier                    TEXT    NOT NULL,
    engine_kind             TEXT    NOT NULL,
    model                   TEXT    NOT NULL,
    provider                TEXT    NOT NULL,               -- "" for cluster/lan
    locality                TEXT    NOT NULL,
    status_class            TEXT    NOT NULL,               -- 2xx | 4xx | 5xx | err
    request_count           INTEGER NOT NULL DEFAULT 0,
    prompt_tokens           INTEGER NOT NULL DEFAULT 0,
    completion_tokens       INTEGER NOT NULL DEFAULT 0,
    cached_tokens           INTEGER NOT NULL DEFAULT 0,
    failover_count          INTEGER NOT NULL DEFAULT 0,
    judge_calls             INTEGER NOT NULL DEFAULT 0,
    error_count             INTEGER NOT NULL DEFAULT 0,
    sum_latency_ms          INTEGER NOT NULL DEFAULT 0,
    sum_ttft_ms             INTEGER NOT NULL DEFAULT 0,
    sum_routing_overhead_ms INTEGER NOT NULL DEFAULT 0,
    sum_cost_usd            REAL    NOT NULL DEFAULT 0,
    p50_latency_ms          INTEGER NOT NULL DEFAULT 0,
    p99_latency_ms          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour_start_ms, route, tier, engine_kind, model, provider, locality, status_class)
);

-- Daily cost, summed by the dimensions budgets and reports care about.
CREATE TABLE IF NOT EXISTS cost_daily (
    day                     TEXT    NOT NULL,               -- YYYY-MM-DD (UTC)
    provider                TEXT    NOT NULL,               -- "" for cluster/lan (notional local cost)
    tier                    TEXT    NOT NULL,
    route                   TEXT    NOT NULL,
    model                   TEXT    NOT NULL,
    locality                TEXT    NOT NULL,
    node                    TEXT    NOT NULL,               -- budgets are per provider per node
    tokens_in               INTEGER NOT NULL DEFAULT 0,
    tokens_out              INTEGER NOT NULL DEFAULT 0,
    request_count           INTEGER NOT NULL DEFAULT 0,
    cost_usd                REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider, tier, route, model, locality, node)
);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version (version) VALUES (1);
