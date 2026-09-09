<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 27. Interim Node router (`YM_DATAPLANE_MODE=router`)

- Status: accepted
- Date: 2026-09-09
- Deciders: @pakgrou-porg
- Relates to: [#36](https://github.com/pakgrou-porg/yardmaster/issues/36),
  [#26](https://github.com/pakgrou-porg/yardmaster/issues/26),
  [ADR-0023](0023-yardmaster-console.md) (same "interim while the Rust piece is built" pattern)

## Context

The Rust `yardmaster-dataplane` (#36) is the real two-stage pipeline — Switchyard
model-selection → PAIR placement, ports 11434/1234/4000, mTLS two-personalities,
metrics. It is a ~980-line typed scaffold; #36 requires first *confirming* the
pinned Switchyard git API is consumable, and there is no Rust toolchain in the
bootstrap environment. It is weeks of work, not a session.

Meanwhile the deployed `runtime-proxy` container can only reach the one local
engine: the PAIR `ollama-proxy` routes among registered PAIR nodes, and the
entrypoint registers exactly one manual node (`127.0.0.1:11434`). The LAN vLLM
and OpenRouter targets in `yardmaster.toml` are valid and visible in the Console
but unroutable. Operators want working autorouting chats now.

## Decision

Ship **`packages/yardmaster-router`** — a small, dependency-light Node service
(only `smol-toml`) — as a third `YM_DATAPLANE_MODE`: **`router`**. It is
explicitly interim, the same way the Console is interim for the full UI.

- **Scope it delivers**: OpenAI `/v1/chat/completions` (+ `/v1/models`) and
  Ollama `/api/chat` (+ `/api/tags`); routing of a request to a `[targets.*]`
  by matching `id` (zero-config pass-through), else the `[routes.default]`
  route; `passthrough` and `escalation` (weak → strong on upstream failure)
  route types; `[egress] allow_remote/allow_lan` enforcement; provider key from
  `api_key_env` (incl. the implicit OpenRouter/venice/kie API roots); response
  streaming; hot config reload on mtime change; one metrics row per request to
  the same SQLite store the Console reads; `x-yardmaster-*` decision headers.
- **Scope it does NOT**: Switchyard learned/`plan_execute` model-selection, PAIR
  GPU-pressure-aware placement, tiers, the `stage_router`/`llm_classifier`/…
  route types (they fall back to the default target), the `:4000` Anthropic
  wire protocol, mTLS cluster ingress, cost estimation. All of that stays #36.

### Wiring

In `router` mode the `yardmaster` container still runs the PAIR proxy workers
(cluster/telemetry/pairing) **and** the router on `127.0.0.1:${YM_ROUTER_PORT}`
(default 4000, loopback). The bundled Console's supervisor starts and watches
it. The LAN bridge points at the router instead of the PAIR proxy, so a client
on published `:11435` gets autorouting. The Harness's `YM_HARNESS_UPSTREAM` is
the router, and `harness-entrypoint.sh` discovers the model list from the
router's `/v1/models` to populate the `dsh-llm-pi-ai` route.

`YM_ROUTER_BIND=0.0.0.0` additionally exposes autorouting on the LAN. Cloud
egress is then reachable, but only when `[egress] allow_remote = true` **and** a
request explicitly names an OpenRouter model id — documented, not default.

## Consequences

- Autorouting chats work today across local / LAN vLLM / OpenRouter, and the
  Console **Metrics** tab populates.
- Another supervised Node process in the `yardmaster` container.
- `YM_DATAPLANE_MODE` now has three values: `proxy` (local-only, no router),
  `router` (this), `dataplane` (the future Rust worker).
- **#36 stays open and is the replacement.** When the Rust data plane lands,
  `router` mode and `packages/yardmaster-router` are removed; `yardmaster.toml`
  and the metrics schema are unchanged, so it is a drop-in swap.
- The router is plaintext + no auth on its own port, same posture as the PAIR
  proxy it stands in for; loopback bind is the default.
