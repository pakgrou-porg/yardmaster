// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! Stage two: placement. A `switchyard-libsy` routing algorithm that turns a
//! logical model name into a concrete node, using PAIR's rules unchanged:
//!
//! 1. **Capability gate** — candidate set is nodes whose running engine
//!    advertises the model.
//! 2. **Scheduler ordering** — the broker's ordering (pending jobs + coarse
//!    GPU pressure) orders the candidates.
//! 3. **Manual pin** — a TUI pin is honored only within the candidate set.
//! 4. **Failover** — PAIR's existing 404-is-retryable semantics.
//!
//! Implementing the libsy `Algorithm` trait means the same code path serves the
//! embedded and proxy cases. `pair_default` must be byte-for-byte equivalent to
//! PAIR's scheduler ordering (ADR-0019); equivalence is asserted with fixtures
//! extracted from `services/nvpair-job-scheduler` Go tests. `warm_first` and
//! `vram_aware` are separate opt-in policies.

#![forbid(unsafe_code)]

/// Placement policy from `[placement] policy` in `yardmaster.toml`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlacementPolicy {
    /// Byte-for-byte PAIR scheduler ordering. The default.
    #[default]
    PairDefault,
    /// Prefer nodes reporting the model already loaded in memory.
    WarmFirst,
    /// Reject nodes whose free VRAM is below a per-model estimate.
    VramAware,
}

/// One placement candidate after the capability gate.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub node_id: String,
    pub engine: String,
    /// Whether the node reports this model already resident (warm).
    pub warm: bool,
    /// Free VRAM in bytes as last reported by node-info, if known.
    pub free_vram_bytes: Option<u64>,
    /// True for a promoted LAN target: ordered after all cluster nodes at equal
    /// pressure because Yardmaster has no telemetry for it (spec 1.7).
    pub is_lan_target: bool,
}
