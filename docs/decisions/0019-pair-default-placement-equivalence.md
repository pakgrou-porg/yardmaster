<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 19. placement.policy = "pair_default" is byte-for-byte PAIR scheduler ordering

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.5: "Ship placement.policy = 'pair_default' with behavior
byte-for-byte equivalent to PAIR's current scheduler ordering." `warm_first` and
`vram_aware` are opt-in. Section 6 requires "placement ordering equivalence
against PAIR's scheduler using fixtures extracted from PAIR's Go tests".

## Decision

`crates/yardmaster-placement` implements the libsy algorithm trait. Under
`pair_default` it reproduces PAIR's capability gate (node's running engine
advertises the model) and the broker's scheduler ordering (pending jobs + coarse
GPU pressure), honoring a manual TUI pin only within the candidate set and PAIR's
404-is-retryable failover. Equivalence is enforced by a test suite whose fixtures
are extracted from `services/nvpair-job-scheduler` Go tests; the Rust ordering
must match the Go ordering for every fixture. `warm_first` (prefer nodes
reporting the model loaded) and `vram_aware` (reject nodes whose free VRAM is
below a per-model estimate) are separate, opt-in policies.

## Alternatives considered

- **Reimplement the scheduler "close enough"** — any divergence changes routing
  for existing PAIR clients, which section 10 requires to be empty or justified.

## Consequences

The final report's "differs from PAIR for an existing client" list stays empty
for placement. A PAIR scheduler change upstream requires re-extracting fixtures
and re-checking equivalence.
