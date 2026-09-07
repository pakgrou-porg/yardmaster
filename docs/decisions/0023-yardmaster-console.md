<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 23. A minimal standalone web console for the interim

- Status: accepted
- Date: 2026-09-07
- Deciders: @pakgrou-porg

## Context

The full Yardmaster UI is the vendored PAIR Electron desktop plus the
Routes/Jobs/Metrics/Tiers/Agent additions in issue #32, driven by broker
JSON-RPC and the Rust data plane. None of that runs yet, and the Electron app
does not containerise. A user deploying Yardmaster in Docker/Portainer today has
no way to edit `yardmaster.toml`, see whether their backends are reachable, look
at metrics, or reach the DeepSeek Harness Web UI from one place.

## Decision

Ship `packages/yardmaster-console` — a small, dependency-light (one dep:
`smol-toml`) loopback web app, and a container image for it. Four tabs:

- **Config** — edit `yardmaster.toml`; validate with a JS validator that mirrors
  `switchyard-server --dry-run` strictness (reject unknown keys) plus
  Yardmaster's superset rules (locality/egress gating, provider key-source and
  HTTPS rules, private-range discovery, port ranges, no literal secrets); save.
  Prefer the real `yardmaster-dataplane dry-run` when `YM_DATAPLANE_BIN` is set.
- **Backends** — parse `[providers.*]` / `[targets.*]` + `YM_LOCAL_ENGINE_URL`
  and probe each for liveness, latency, and model inventory (plain HTTP GETs —
  works with no data plane).
- **Metrics** — read-only view of `yardmaster-metrics.db` against the schema in
  `crates/yardmaster-metrics/migrations`. Empty shell until the data plane
  writes events. No prompt/response content is stored or shown.
- **Agent** — embed the dsh Web UI (`YM_AGENT_URL`).

It is explicitly a stopgap: it does not implement route CRUD, cluster control,
pairing, or discovery, and it is superseded by #32 when the data plane lands.

## Alternatives considered

- **Wait for #32** — leaves containerised users with no UI for months.
- **Serve the PAIR Electron renderer as a web app** — the renderer is bound to
  the Electron preload bridge and the broker's stdio JSON-RPC; not a web app
  without significant work, and it would still need the unbuilt data plane.
- **A dsh plugin panel** — dsh's UI is the agent surface, not a Yardmaster admin
  surface; mixing them couples our config UI to dsh's release cadence.

## Consequences

Users can configure and observe Yardmaster now. The console's JS validator
duplicates rules that also live in the Rust `dry-run`; the console prefers the
binary when present, and the duplicated rules are covered by
`packages/yardmaster-console/test/validate.test.mjs` so drift is visible. The
console binds loopback by default; its container image binds `0.0.0.0` for port
publishing and the stacks publish it on host loopback only.
