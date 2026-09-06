<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 8. Remote egress is off by default and requires dual opt-in

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

The governing constraint for every underspecified choice is to keep prompts on
the local network by default. Specification 1.4 defines target `locality` as
`cluster` (default), `lan`, or `remote`, and says remote targets "are disabled
unless [egress] allow_remote = true is set in the config file and the same
toggle is on in the desktop UI."

## Decision

`[egress] allow_remote` defaults to `false`. A `locality = "remote"` target is
usable only when both `allow_remote = true` in `yardmaster.toml` **and** the
desktop Settings -> Egress toggle are set. `[egress] allow_lan` defaults to
`true` and gates `locality = "lan"` targets (private-range plaintext endpoints
that are not paired nodes). When a remote target is enabled, the UI shows a
persistent indicator on the node card and on every job that used it. Config
validation rejects a route whose selected or judge target is `remote` while
`allow_remote = false`.

## Alternatives considered

- **Single file-only toggle** — one accidental config edit sends prompts off the
  LAN with no second, visible confirmation.
- **Remote on by default when a provider key is present** — violates the
  local-by-default constraint outright.

## Consequences

Off-LAN traffic always has a visible, revocable switch and an audit trail on
jobs. Tests: a route with a remote judge and `allow_remote = false` fails config
validation; budgets are enforced before dispatch so a disabled/exhausted remote
falls to the next tier.
