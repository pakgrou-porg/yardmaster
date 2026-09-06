<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Metrics, logging, and reporting

Metrics are a first-class subsystem (`crates/yardmaster-metrics`), not a
`/metrics` endpoint bolted on. **No prompt or completion text is ever collected,
stored, exported, or logged.** See
[decisions/0012](decisions/0012-metrics-store.md).

## Event schema

One structured event per request, at completion or abort. Every column is on an
allowlist asserted by a schema test; adding a field means updating the allowlist
and this table.

| Field | Notes |
| --- | --- |
| `request_id` | Correlates with the decision trace. Never a metric label. |
| `client_ingress_protocol`, `client_ingress_port` | `ollama` / `openai_chat` / `openai_responses` / `anthropic_messages`; `11434` / `1234` / `4000`. |
| `client_identity` | Loopback PID where the OS permits, else the connecting address. Stored value beyond loopback is a classification only. |
| `route`, `algorithm`, `tier_decided` | |
| `decision_reason` | Signal name, judge verdict class, random draw, or `passthrough`. |
| `rule` | For `plan_execute`: the exact rule that fired. |
| `candidate_set_size`, `failover_count` | |
| `node_or_provider`, `engine_kind`, `model` | |
| `prompt_tokens`, `completion_tokens`, `cached_tokens` | `cached_tokens` where the engine reports it. |
| `time_to_first_token_ms`, `total_latency_ms`, `routing_overhead_ms` | `routing_overhead` = time inside Yardmaster excluding upstream. |
| `judge_latency_ms`, `judge_tokens` | |
| `stream`, `http_status`, `error_class` | |
| `estimated_cost_usd`, `locality` | |
| `session_id`, `agent_id`, `step_id`, `tier_rule` | Present when the request came from DeepSeek Harness (`metrics.ingest`). |

Headers other than `content-type` / `content-length` are not recorded.

## Store

SQLite (WAL) in PAIR's data directory: `yardmaster-metrics.db`. Tables
`events`, `rollups_hourly`, `cost_daily`. File mode `0600` (POSIX) / user-only
ACL (Windows). Retention: `events` pruned after `[metrics] retention_days`
(default 30); rollups kept 365 days. Peer events replicate over PAIR's existing
mTLS workload port (an events stream added to `nvpair-workload-manager`), so any
node can report on the whole cluster.

## Exposure

Three outputs; all on by default except OTLP.

### Prometheus — `:4000/metrics`

Keeps Switchyard's existing metric names; adds Yardmaster's under `yardmaster_`.
Labels are bounded: `route`, `tier`, `node`, `provider`, `engine`, `model`,
status class, `locality`. **Never** a request id or a client address. A
cardinality test rejects any label value that looks like a UUID or an address.

| Metric | Type | Labels |
| --- | --- | --- |
| `yardmaster_requests_total` | counter | route, tier, engine, status_class, locality |
| `yardmaster_request_latency_seconds` | histogram | route, tier, node |
| `yardmaster_routing_overhead_seconds` | histogram | route, algorithm |
| `yardmaster_tokens_total` | counter | route, tier, model, direction |
| `yardmaster_judge_calls_total` | counter | route, verdict |
| `yardmaster_failovers_total` | counter | route, reason |
| `yardmaster_cost_usd_total` | counter | provider, tier, route |
| `yardmaster_provider_budget_remaining_usd` | gauge | provider, node |
| `yardmaster_discovery_endpoints` | gauge | kind, promoted |

### OTLP

Off unless `[metrics] otlp_endpoint` is set; the endpoint must be HTTPS or
loopback. One span per request:

```text
request
├── ingress.translate
├── model.select            (algorithm; child: judge.call when applicable)
├── placement               (capability gate + ordering; child per failover)
├── upstream                (child: upstream.stream when streaming)
└── egress.translate
```

### JSON-RPC (UI and TUI)

| Method | Params | Returns |
| --- | --- | --- |
| `metrics.query` | time range, `group_by`, filters (route, tier, node, provider, client) | series |
| `metrics.report` | date range | a Markdown document (see below) |
| `metrics.export` | `format` (`csv` \| `json`), `path` | writes the file the user chose |
| `metrics.ingest` | per-step token/cache counts + `session_id`/`agent_id`/`step_id`/`tier_rule` | ack; **loopback callers only**, validated against the schema |

## Cost model

`crates/yardmaster-cost`. Price resolution: (1) provider `/models` pricing
(OpenRouter, cached 24 h); (2) `[providers.<name>.pricing]`; (3)
`[metrics] local_cost_usd_per_million_tokens` (default `0`). Daily rollups sum by
provider, tier, route. Budgets read from this table and are enforced **before
dispatch**.

## Reports (`metrics.report` / `yardmaster report`)

A Markdown document for a date range with:

- Totals for the range.
- A table of routes: request count, tier split, escalation rate, cost.
- A table of nodes and providers: share of requests, p50 / p99 latency, error
  rate, cost.
- A savings estimate: actual cost vs "everything on the most expensive tier
  used" and vs "everything on the cheapest".
- The ten slowest and ten most expensive routes.
- A per-session section when DeepSeek Harness correlation is present.

CLI, same document, no UI:

```bash
yardmaster-dataplane report --from 2026-09-01 --to 2026-09-07 --out report.md
```

## Logging

Structured JSON to stderr, PAIR conventions.

| Level | What |
| --- | --- |
| `error` | upstream failures — status and error class |
| `warn` | failovers, budget exhaustion, discovery evictions |
| `info` | routing decisions — route, tier, node; **no content** |
| `debug` | translation details — **body sizes only** |

`--log-routing-file <path>` mirrors Switchyard's `--routing-log-file`: decision
traces as JSON lines. Log rotation is the platform's job; per-OS configuration is
documented in [migrating-from-pair.md](migrating-from-pair.md).
