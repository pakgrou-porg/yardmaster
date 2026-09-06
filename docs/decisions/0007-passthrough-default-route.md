<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 7. Unknown model names fall through to a passthrough route

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.3: "A passthrough route with a bare model name is the default
when the client names a model that is not a configured route, so PAIR's existing
'point curl at 11434 with qwen4:12b' flow works unchanged with no config file
present."

## Decision

When the request's `model` does not match a `[routes]` entry, the data plane
synthesizes a `passthrough` route whose tier target is the literal model name.
Model selection is a no-op; placement resolves that logical model against the
live cluster exactly as PAIR does today. No `yardmaster.toml` is required for
this path.

## Alternatives considered

- **Reject unknown models with 404** — breaks every existing PAIR client on
  first request.
- **Route unknown models to a configured default tier** — surprising; hides
  typos; not what PAIR users expect.

## Consequences

Zero-config behavior is byte-for-byte PAIR (see ADR-0019). A typo in a model
name produces PAIR's existing "no node has this model" behavior, not a routing
error. Documented as the zero-config path in `docs/migrating-from-pair.md`.
