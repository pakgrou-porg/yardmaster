<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 6. Ingress port assignments 11434 / 1234 / 4000

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.2 fixes the three ingress ports; specification 9 forbids changing
PAIR's port numbers. 11434 is Ollama's port, 1234 is LM Studio's, both taken over
by PAIR today so existing clients gain the cluster unchanged. 4000 is
Switchyard's server default (`switchyard-server --port 4000`).

## Decision

- **11434** — Ollama-compatible ingress: native `/api/chat`, `/api/generate`,
  `/api/tags`, `/api/show`, plus `/v1/*` OpenAI-compatible.
- **1234** — OpenAI-compatible ingress: `/v1/chat/completions`, `/v1/responses`,
  `/v1/models`.
- **4000** — Anthropic Messages ingress `/v1/messages`, plus Switchyard's
  `/health` and `/metrics`.

Configurable via `[ingress]` in `yardmaster.toml`; defaults as above. All three
carry PAIR's two-personalities-on-one-port behavior (first byte `0x16` =>  mTLS
cluster ingress; otherwise plaintext, loopback-only, else `403`).

## Alternatives considered

- **A single new port for everything** — breaks the "point existing Ollama/LM
  Studio clients at their usual port" property that is the whole product shape.

## Consequences

Port collisions with a still-running native Ollama or LM Studio are handled the
same way PAIR handles them (take over the port). `/metrics` and `/health` live on
4000 to match Switchyard; Prometheus scrape config targets 4000.
