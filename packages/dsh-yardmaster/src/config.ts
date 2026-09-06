// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration for the `dsh-yardmaster` plugin.
 *
 * Secrets are never here: the plugin talks to the Yardmaster data plane on
 * loopback and the data plane holds provider keys (see
 * docs/decisions/0016-dsh-child-env-stripped.md).
 */

/** A single rule in the tier policy. Evaluated top to bottom; first match wins. */
export interface TierRule {
  /** Stable id shown in the `yardmaster/decision` session event. */
  readonly id: string;
  /**
   * A declarative predicate over harness-native step structure. The evaluator in
   * `tier-policy.ts` understands these keys; unknown keys fail closed (skip).
   */
  readonly when: {
    readonly rootFirstStepNoToolResults?: boolean;
    readonly afterGoalsChange?: boolean;
    readonly inputContainsPlanCommand?: boolean;
    readonly afterToolResult?: boolean;
    readonly insideSubagent?: boolean;
    readonly jobCollectionStep?: boolean;
    readonly consecutiveToolFailuresAtLeast?: number;
    readonly toolsExecuteError?: boolean;
    readonly contextExceedsWorkerSmallestWindow?: boolean;
    readonly cacheHitRateAbove?: number;
    readonly always?: boolean;
  };
  /** Tier to request for the coming step. */
  readonly tier: "planner" | "worker";
  /** When set, request `tier` for exactly one step, then return to `worker`. */
  readonly escalateOneStep?: boolean;
}

export interface YardmasterPluginConfig {
  /** Data-plane base URL. OpenAI-compatible ingress by default. */
  readonly endpoint: string;
  /** Anthropic Messages ingress, used when the selected route prefers it. */
  readonly anthropicEndpoint: string;
  /** The Yardmaster route or tier the harness uses by default. */
  readonly route: string;
  /**
   * The tier policy as a plain, user-patchable array. A user patch can rewrite
   * this without touching plugin code. The default mirrors spec 1.10.
   */
  readonly tierPolicy: readonly TierRule[];
  /** JSON-RPC endpoint for `metrics.ingest` (loopback only). */
  readonly metricsIngestUrl: string;
  /** Optional: enable the cache-hit-rate demotion signal (default off). */
  readonly demoteWhenCacheHitRateAbove?: number;
}

/** The default tier policy from specification section 1.10. */
export const DEFAULT_TIER_POLICY: readonly TierRule[] = [
  { id: "root-first-step", when: { rootFirstStepNoToolResults: true }, tier: "planner" },
  { id: "after-goals-change", when: { afterGoalsChange: true }, tier: "planner" },
  { id: "input-plan-command", when: { inputContainsPlanCommand: true }, tier: "planner" },
  { id: "two-tool-failures", when: { consecutiveToolFailuresAtLeast: 2 }, tier: "planner", escalateOneStep: true },
  { id: "tools-execute-error", when: { toolsExecuteError: true }, tier: "planner", escalateOneStep: true },
  { id: "context-over-worker-window", when: { contextExceedsWorkerSmallestWindow: true }, tier: "planner", escalateOneStep: true },
  { id: "after-tool-result", when: { afterToolResult: true }, tier: "worker" },
  { id: "inside-subagent", when: { insideSubagent: true }, tier: "worker" },
  { id: "job-collection-step", when: { jobCollectionStep: true }, tier: "worker" },
  { id: "default-worker", when: { always: true }, tier: "worker" },
];

export const DEFAULT_CONFIG: YardmasterPluginConfig = {
  endpoint: "http://127.0.0.1:1234/v1",
  anthropicEndpoint: "http://127.0.0.1:4000",
  route: "plan-execute",
  tierPolicy: DEFAULT_TIER_POLICY,
  metricsIngestUrl: "http://127.0.0.1:4000/rpc",
};
