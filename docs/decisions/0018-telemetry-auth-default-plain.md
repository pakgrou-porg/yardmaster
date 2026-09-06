<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 18. Node telemetry stays plaintext by default (telemetry_auth = "plain")

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification section 4: "Node telemetry on 14318 remains plaintext in PAIR. Do
not widen it. Document it in docs/security.md as an inherited exposure and add a
config flag [cluster] telemetry_auth = 'mtls' that, when set, moves node-info
behind the mTLS personality; default stays 'plain' to remain PAIR-compatible."

## Decision

`[cluster] telemetry_auth` defaults to `"plain"`. Yardmaster does not change
PAIR's port 14318 behavior. Setting `telemetry_auth = "mtls"` moves `node-info`
behind the mTLS personality. The desktop shows a one-time notice recommending
`mtls` on shared networks. `docs/security.md` lists 14318 as an inherited
exposure.

## Alternatives considered

- **Default to mtls** — safer, but breaks compatibility with an existing PAIR
  cluster mid-upgrade; the spec explicitly wants `plain` as the default.

## Consequences

An existing PAIR cluster keeps working after upgrading one node to Yardmaster.
Users on untrusted networks have a documented one-line hardening step.
