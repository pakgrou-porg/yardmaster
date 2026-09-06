// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! `plan_execute`: planner / worker / judge tiering as a first-class
//! `switchyard-libsy` algorithm (not a special case).
//!
//! Each turn is classified planning-or-execution using, in order, stopping at
//! the first that applies:
//!
//! 1. **Explicit client hints** — `X-Yardmaster-Tier: planner|worker`
//!    header, OpenAI `metadata.yardmaster_tier`, or Anthropic
//!    `metadata.user_id` suffix `#tier=planner`.
//! 2. **Conversation signals** — reusing Switchyard's `stage_router` signal
//!    machinery (first user turn with no tool results; system prompt mentions
//!    planning/decomposition; assistant emitted a plan/task list; explicit
//!    "plan"/"replan"; a turn after a tool result; a single sub-task; a tool
//!    call in flight).
//! 3. **Judge fallback** — the judge tier answers "planning or execution"
//!    from the last N messages with a bounded prompt
//!    (docs/prompts/plan_execute_judge.md).
//!
//! `escalate_on = ["tool_error", "repeated_failure", "long_context"]` promotes
//! an execution turn to the planner tier; `demote_after_plan = true` returns to
//! the worker tier on the turn after a plan. Every decision names the rule that
//! fired, for the Jobs view.

#![forbid(unsafe_code)]

/// A tier's role, from `[tiers.<name>] role`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TierRole {
    Planner,
    Worker,
    Judge,
}

/// The classification outcome for a turn, plus which rule produced it.
#[derive(Debug, Clone)]
pub struct TurnDecision {
    pub role: TierRole,
    /// Human-readable name of the rule that fired, e.g. "hint:header",
    /// "signal:first_user_turn", "judge", "escalate:tool_error",
    /// "demote_after_plan".
    pub rule: String,
}
