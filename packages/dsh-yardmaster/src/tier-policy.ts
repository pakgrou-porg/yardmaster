// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import type { TierRule } from "./config.js";

/**
 * The harness-native facts a pre-step listener can observe about the step that
 * is about to run. Populated from the `agent/pre-step` payload; this scaffold
 * documents the shape the evaluator consumes. Values it cannot determine are
 * left `undefined` and treated as "does not match".
 */
export interface StepFacts {
  readonly isRootAgent: boolean;
  readonly isFirstStepInTurn: boolean;
  readonly toolResultsOwed: number;
  readonly goalsChangedSinceLastStep: boolean;
  readonly claimedInputText: string;
  readonly followsToolResult: boolean;
  readonly insideSubagent: boolean;
  readonly isJobCollectionStep: boolean;
  readonly consecutiveToolFailures: number;
  readonly hadToolsExecuteError: boolean;
  readonly sessionContextTokens: number;
  readonly workerTierSmallestContextWindow: number;
  readonly sessionCacheHitRate: number;
}

export interface TierDecision {
  readonly tier: "planner" | "worker";
  /** The `id` of the rule that fired — surfaced in `yardmaster/decision`. */
  readonly rule: string;
  readonly escalateOneStep: boolean;
}

const PLAN_CMD = /\b(re)?plan\b/i;

function matches(rule: TierRule, f: StepFacts): boolean {
  const w = rule.when;
  if (w.always) return true;
  if (w.rootFirstStepNoToolResults)
    return f.isRootAgent && f.isFirstStepInTurn && f.toolResultsOwed === 0;
  if (w.afterGoalsChange) return f.goalsChangedSinceLastStep;
  if (w.inputContainsPlanCommand) return PLAN_CMD.test(f.claimedInputText);
  if (w.afterToolResult) return f.followsToolResult;
  if (w.insideSubagent) return f.insideSubagent;
  if (w.jobCollectionStep) return f.isJobCollectionStep;
  if (typeof w.consecutiveToolFailuresAtLeast === "number")
    return f.consecutiveToolFailures >= w.consecutiveToolFailuresAtLeast;
  if (w.toolsExecuteError) return f.hadToolsExecuteError;
  if (w.contextExceedsWorkerSmallestWindow)
    return f.sessionContextTokens > f.workerTierSmallestContextWindow;
  if (typeof w.cacheHitRateAbove === "number")
    return f.sessionCacheHitRate > w.cacheHitRateAbove;
  return false;
}

/**
 * Evaluate the policy against the coming step. First matching rule wins;
 * `default-worker` (`always`) guarantees a decision.
 */
export function evaluateTierPolicy(
  policy: readonly TierRule[],
  facts: StepFacts,
): TierDecision {
  for (const rule of policy) {
    if (matches(rule, facts)) {
      return {
        tier: rule.tier,
        rule: rule.id,
        escalateOneStep: rule.escalateOneStep ?? false,
      };
    }
  }
  return { tier: "worker", rule: "fallthrough", escalateOneStep: false };
}
