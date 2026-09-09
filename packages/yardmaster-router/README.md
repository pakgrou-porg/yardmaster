<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# @pakgrou-porg/yardmaster-router

The **interim** inference data plane for Yardmaster, run as
`YM_DATAPLANE_MODE=router`. Config-driven routing of OpenAI / Ollama chat
requests to local / LAN / OpenRouter backends by model id, with `passthrough`
and `escalation` routes, streaming, and per-request metrics.

It is a placeholder for the Rust `yardmaster-dataplane`
([#36](https://github.com/pakgrou-porg/yardmaster/issues/36)); `yardmaster.toml`
and the metrics schema are the same, so the eventual swap is drop-in. See
[ADR-0027](../../docs/decisions/0027-interim-node-router.md).

## Endpoints

| Method + path | Purpose |
| --- | --- |
| `GET /healthz` | mode, config path, target count |
| `GET /v1/models` · `GET /api/tags` | every routable model id |
| `POST /v1/chat/completions` | OpenAI Chat Completions (stream + non-stream) |
| `POST /api/chat` | Ollama chat (translated to/from OpenAI) |

Responses carry `x-yardmaster-route` / `-target` / `-provider` / `-locality` /
`-failover`.

## Routing

1. A request whose `model` equals a `[targets.*].id` goes straight to that
   target (zero-config pass-through).
2. Otherwise `[routes.default]` applies: `passthrough` → its `target`;
   `escalation` → `weak_target`, then `strong_target` on upstream failure.
   Other route types fall back to the default `target`.
3. `[egress] allow_remote` / `allow_lan` are enforced. Provider keys come from
   the env var named by `api_key_env` (incl. the implicit OpenRouter / Venice /
   KIE API roots).

## Env

`YM_ROUTER_PORT` (4000) · `YM_ROUTER_BIND` (127.0.0.1) · `YM_ROUTER_CONFIG`
(`/config/yardmaster.toml`) · `YM_CONFIG_FALLBACK` · `YM_METRICS_DB` ·
`YM_ROUTER_TIMEOUT_MS` (300000). The config is hot-reloaded on mtime change.
