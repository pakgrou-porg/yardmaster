// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! Remote and LAN providers behind one trait.
//!
//! Ship kinds: `openrouter` and `venice` (OpenAI-compatible base URLs),
//! `kie` (task-based: create-task + poll-result + streaming shim), and
//! `openai_compatible` (generic; vLLM, NIM, OCI Generative AI, Bedrock proxy).
//!
//! Keys are read only from an environment variable (`api_key_env`) or the OS
//! credential store (`api_key_ref`) — never from `yardmaster.toml`, never
//! sent to the renderer, never in a decision trace, metric label, or log line,
//! and redacted in any error that echoes a request. `base_url` overrides for
//! `openrouter` / `venice` / `kie` must be HTTPS; HTTP is accepted only for
//! `openai_compatible` on a private range. Clients pin TLS 1.2+, verify certs,
//! and never follow a cross-host redirect.

#![forbid(unsafe_code)]

use std::time::Duration;

/// The provider kinds Yardmaster ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Openrouter,
    Venice,
    Kie,
    OpenaiCompatible,
}

/// Where a credential is read from. Exactly one is required for openrouter,
/// venice, and kie; openai_compatible may have neither.
#[derive(Debug, Clone)]
pub enum CredentialRef {
    /// Name of an environment variable to read at process start.
    Env(String),
    /// Key into the OS credential store (via the Electron main process).
    CredStore(String),
    /// Unauthenticated local server (openai_compatible only).
    None,
}

/// Common configuration for every `[providers.<name>]` table.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub base_url: Option<String>,
    pub credential: CredentialRef,
    pub models_allow: Vec<String>,
    pub models_deny: Vec<String>,
    pub rate_limit_rpm: Option<u32>,
    pub budget_usd_per_day: Option<f64>,
    pub timeout: Duration,
    /// kie only: image/video/music endpoints exist but are out of scope for
    /// routing; exposed as a capability flag for a future tool layer.
    pub media_capability: bool,
}

/// Provider errors. `Display` never contains a key or request body.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider is unavailable: {0}")]
    Unavailable(String),
    #[error("daily budget exhausted; falling back to next tier")]
    BudgetExhausted,
    #[error("upstream error {status}")]
    Upstream { status: u16 },
    #[error("configuration rejected: {0}")]
    Config(String),
}

/// The one trait every provider kind implements.
#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    /// Inventory with pricing/context where the provider exposes it.
    async fn list_models(&self) -> Result<Vec<String>, ProviderError>;
    // chat / stream / usage / cost_estimate land here; see the blocked issue.
}
