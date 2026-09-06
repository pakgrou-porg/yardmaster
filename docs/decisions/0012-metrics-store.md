<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 12. Metrics store is SQLite (WAL) under PAIR's data dir, with no content columns

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.8: events are "written by the data plane to a local append-only
store: SQLite in WAL mode under PAIR's data directory, one table for events, one
for hourly rollups, one for daily cost", retention `[metrics] retention_days`
(default 30), rollups kept one year, no prompt or completion text ever, file
mode 0600 on POSIX / user-only ACL on Windows.

## Decision

`crates/yardmaster-metrics` owns the schema and an embedded SQLite database
(`yardmaster-metrics.db`, WAL) in PAIR's existing data directory. Tables:
`events`, `rollups_hourly`, `cost_daily`. Every column is on an allowlist
asserted by a schema test; there is no column for prompt, completion, headers
(other than `content-type` / `content-length`), or full client addresses beyond
a loopback/non-loopback classification. Created 0600 / user-only ACL. Peer events
replicate over PAIR's existing mTLS workload port by extending
`nvpair-workload-manager` with an events stream. Retention prunes `events` after
`retention_days`; rollups after 365 days.

## Alternatives considered

- **Prometheus-only, no store** — cannot answer historical `metrics.report`
  queries or per-day cost.
- **A separate database file location** — fragments PAIR's data directory and
  its uninstall story.

## Consequences

`metrics.query` / `metrics.report` / `metrics.export` and the `yardmaster report`
CLI all read this store. OTLP export is off unless `[metrics] otlp_endpoint` is
set, and that endpoint must be HTTPS or loopback.
