// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { DEFAULT_TIER_POLICY } from "./config.js";
import { evaluateTierPolicy, type StepFacts } from "./tier-policy.js";
import { YardmasterAdapter } from "./adapter.js";
import { DEFAULT_CONFIG } from "./config.js";

function facts(over: Partial<StepFacts>): StepFacts {
  return {
    isRootAgent: true,
    isFirstStepInTurn: true,
    toolResultsOwed: 0,
    goalsChangedSinceLastStep: false,
    claimedInputText: "",
    followsToolResult: false,
    insideSubagent: false,
    isJobCollectionStep: false,
    consecutiveToolFailures: 0,
    hadToolsExecuteError: false,
    sessionContextTokens: 0,
    workerTierSmallestContextWindow: 8000,
    sessionCacheHitRate: 0,
    ...over,
  };
}

describe("default tier policy", () => {
  it("root first step with no tool results -> planner", () => {
    const d = evaluateTierPolicy(DEFAULT_TIER_POLICY, facts({}));
    expect(d).toMatchObject({ tier: "planner", rule: "root-first-step" });
  });

  it("a step after a tool result -> worker", () => {
    const d = evaluateTierPolicy(
      DEFAULT_TIER_POLICY,
      facts({ isFirstStepInTurn: false, followsToolResult: true }),
    );
    expect(d).toMatchObject({ tier: "worker", rule: "after-tool-result" });
  });

  it("two consecutive tool failures -> planner for one step", () => {
    const d = evaluateTierPolicy(
      DEFAULT_TIER_POLICY,
      facts({ isFirstStepInTurn: false, consecutiveToolFailures: 2 }),
    );
    expect(d).toMatchObject({ tier: "planner", rule: "two-tool-failures", escalateOneStep: true });
  });

  it("inside a subagent -> worker", () => {
    const d = evaluateTierPolicy(
      DEFAULT_TIER_POLICY,
      facts({ isRootAgent: false, isFirstStepInTurn: false, insideSubagent: true }),
    );
    expect(d).toMatchObject({ tier: "worker", rule: "inside-subagent" });
  });

  it("context over the worker tier's smallest window -> planner for one step", () => {
    const d = evaluateTierPolicy(
      DEFAULT_TIER_POLICY,
      facts({
        isFirstStepInTurn: false,
        sessionContextTokens: 9000,
        workerTierSmallestContextWindow: 8000,
      }),
    );
    expect(d).toMatchObject({ tier: "planner", rule: "context-over-worker-window" });
  });

  it("always terminates with a decision", () => {
    const d = evaluateTierPolicy(
      DEFAULT_TIER_POLICY,
      facts({ isRootAgent: false, isFirstStepInTurn: false }),
    );
    expect(d.tier).toBe("worker");
  });
});

describe("adapter correlation headers", () => {
  it("sets session/agent/step and tier when given", () => {
    const a = new YardmasterAdapter(DEFAULT_CONFIG);
    const h = a.headersFor({ sessionId: "s1", agentId: "a1", stepId: "st1", tier: "planner" });
    expect(h).toEqual({
      "X-Yardmaster-Session": "s1",
      "X-Yardmaster-Agent": "a1",
      "X-Yardmaster-Step": "st1",
      "X-Yardmaster-Tier": "planner",
    });
  });

  it("routes Anthropic-preferring requests to :4000", () => {
    const a = new YardmasterAdapter(DEFAULT_CONFIG);
    expect(a.baseUrlFor(true)).toBe("http://127.0.0.1:4000");
    expect(a.baseUrlFor(false)).toBe("http://127.0.0.1:1234/v1");
  });
});
