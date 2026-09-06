<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 11. One provider trait, four first-class provider kinds

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.4 requires `crates/yardmaster-providers` with `openrouter`,
`venice`, `kie`, and `openai_compatible` "behind a common trait (list_models,
chat, stream, usage, cost_estimate)", each configured by a `[providers.<name>]`
table with a fixed set of keys, keys read only from env or the OS credential
store.

## Decision

A `Provider` trait with `list_models`, `chat`, `stream`, `usage`, and
`cost_estimate`, one module per kind. `openrouter` and `venice` are
OpenAI-compatible base URLs (`https://openrouter.ai/api/v1`,
`https://api.venice.ai/api/v1`); `openrouter` parses `/models` pricing and
context length and caches it 24 h. `kie` (`https://api.kie.ai`) is a task-based
adapter: create-task + poll-result with a streaming shim; its image/video/music
endpoints are out of scope for routing and are surfaced only as a `media`
capability flag. `openai_compatible` is the generic fallback (vLLM, NIM, OCI
Generative AI, Bedrock proxy). `base_url` overrides for `openrouter`, `venice`,
`kie` must be HTTPS; HTTP is accepted only for `openai_compatible` on a private
range. Exactly one of `api_key_env` / `api_key_ref` is required for `openrouter`,
`venice`, `kie`; `openai_compatible` may omit both. Provider HTTP clients pin TLS
1.2+, verify certificates, and never follow cross-host redirects.

## Alternatives considered

- **Only a generic OpenAI-compatible provider** — cannot express OpenRouter
  pricing, Venice pass-through params, or kie's task model.
- **kie as a plain base URL** — kie is not OpenAI-compatible; a plain adapter
  would not work.

## Consequences

`kie`'s current chat surface is read from its live API docs at build time; if
that surface changes, the adapter is the single place to update. Contract tests
run against recorded fixtures and never fail CI for missing keys.
