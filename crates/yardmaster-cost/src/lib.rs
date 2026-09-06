// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! Cost model and budgets.
//!
//! Price resolution order (spec 1.8): (1) provider `/models` pricing (cached
//! 24 h for OpenRouter); (2) `[providers.<name>.pricing]` overrides;
//! (3) `[metrics] local_cost_usd_per_million_tokens` (default 0) for
//! cluster/LAN models. Every metrics event carries an estimate. Budgets
//! (`budget_usd_per_day`, per provider per node) are enforced **before
//! dispatch**: a request whose estimate would exceed the remaining daily budget
//! is not sent and the route falls to its next tier.

#![forbid(unsafe_code)]

/// USD per million tokens, split by direction.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
pub struct ModelPrice {
    pub input_usd_per_mtok: f64,
    pub output_usd_per_mtok: f64,
}

/// Where a price came from, recorded on the event for auditability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceSource {
    ProviderModels,
    ConfigOverride,
    NotionalLocal,
    Unknown,
}

/// Estimate a cost in USD for a completed request.
pub fn estimate_usd(price: ModelPrice, prompt_tokens: u64, completion_tokens: u64) -> f64 {
    let m = 1_000_000.0;
    (prompt_tokens as f64 / m) * price.input_usd_per_mtok
        + (completion_tokens as f64 / m) * price.output_usd_per_mtok
}
