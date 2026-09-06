// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * `dsh-yardmaster` — a DeepSeek Harness (Cordis) plugin.
 *
 * dsh owns sessions, tools, sandboxing, approvals, the agent loop, and the
 * agent UI. Yardmaster owns which model answers, where it runs, what it costs,
 * and what happened. This plugin is the seam between them and registers, using
 * documented extension points and nothing else:
 *
 *  - `ctx.llm` adapter `yardmaster` -> the data plane on loopback.
 *  - an `agent/pre-step` listener that picks a tier hint from harness-native
 *    step structure using the user-patchable `tierPolicy`, and attaches the
 *    chosen tier + firing rule to the step as a `yardmaster/decision` session
 *    event (SessionEventMap is extended so it survives reload).
 *  - a subagent provider that runs children through the same adapter with
 *    `X-Yardmaster-Tier: worker` fixed, plus a fan-out helper (N independent
 *    tasks -> N children Yardmaster places across the cluster in parallel).
 *  - read-only `ctx.tools`: `yardmaster_models`, `yardmaster_status`,
 *    `yardmaster_report`. No tool changes routing, egress, or providers.
 *  - one `ctx.commands` entry, `/yardmaster`, printing the last decision trace
 *    and session cost without spending a model turn.
 *  - a `telemetry/*` listener forwarding per-step token/cache stats to the data
 *    plane's `metrics.ingest` JSON-RPC (loopback, counts and ids only).
 *  - a Web Client Chat node rendering `yardmaster/decision` inline.
 *
 * It registers no `ctx.fs`, `ctx.shell`, `ctx.sandbox`, or `ctx.subprocess`
 * provider and does not touch approval policy. dsh's SAFETY.md governs what the
 * agent may do on the machine; Yardmaster does not weaken it.
 *
 * Status: scaffold. Each registration below is a documented stub; the wiring is
 * tracked by a `blocked` issue linked from README.md.
 */

import { DEFAULT_CONFIG, type YardmasterPluginConfig } from "./config.js";
import { YardmasterAdapter } from "./adapter.js";
import { evaluateTierPolicy, type StepFacts } from "./tier-policy.js";

export const name = "dsh-yardmaster";

/** Documented dsh services this plugin depends on. */
export const inject = ["llm", "agent", "tools", "commands", "session"] as const;

/**
 * Cordis `apply`. `ctx` is the harness `Context`; typed loosely here so the
 * scaffold builds without the full dsh type surface resolved. The real plugin
 * imports `Context` from `@deepseek-ai/dsh`.
 */
export function apply(ctx: any, config: YardmasterPluginConfig = DEFAULT_CONFIG): void {
  const cfg: YardmasterPluginConfig = { ...DEFAULT_CONFIG, ...config };
  const adapter = new YardmasterAdapter(cfg);

  // 1) LLM adapter. Effect-based registration (HMR-safe); one adapter per route.
  ctx.llm?.registerAdapter?.(["yardmaster"], adapter);

  // 2) Pre-step tier hint. Compute the tier for the coming step and record it.
  ctx.on?.("agent/pre-step", (step: unknown) => {
    const facts = deriveStepFacts(step);
    const decision = evaluateTierPolicy(cfg.tierPolicy, facts);
    ctx.session?.emit?.("yardmaster/decision", {
      tier: decision.tier,
      rule: decision.rule,
      escalateOneStep: decision.escalateOneStep,
      route: cfg.route,
    });
    // The adapter reads the recorded decision to set X-Yardmaster-Tier.
  });

  // 3) Subagent provider: children run worker-tier through the same adapter.
  ctx.agent?.registerSubagentProvider?.("yardmaster", {
    fixedTier: "worker" as const,
    // fanOut(tasks): spawn one child per independent task; Yardmaster places
    // them across the cluster in parallel. Tracked: blocked issue.
  });

  // 4) Read-only tools.
  for (const tool of ["yardmaster_models", "yardmaster_status", "yardmaster_report"]) {
    ctx.tools?.register?.(tool, { readOnly: true, handler: async () => ({ todo: tool }) });
  }

  // 5) Human command.
  ctx.commands?.register?.("/yardmaster", {
    description: "Print the last Yardmaster decision trace and session cost so far.",
    handler: async () => ({ todo: "last decision trace + session cost" }),
  });

  // 6) Telemetry forwarder: counts and ids only, loopback only.
  ctx.on?.("telemetry/step", (stats: unknown) => {
    void forwardMetrics(cfg.metricsIngestUrl, stats);
  });

  // 7) Web Client Chat node for `yardmaster/decision` (registered with the web
  //    client module when present). Tracked: blocked issue.
  ctx.webClient?.registerChatNode?.("yardmaster/decision", { component: "YardmasterDecision" });
}

/** Map an `agent/pre-step` payload onto the facts the policy evaluator needs. */
function deriveStepFacts(_step: unknown): StepFacts {
  // Scaffold defaults. The real mapping reads the pre-step payload.
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
    workerTierSmallestContextWindow: Number.MAX_SAFE_INTEGER,
    sessionCacheHitRate: 0,
  };
}

/** POST counts/ids only to the data plane's loopback `metrics.ingest`. */
async function forwardMetrics(url: string, stats: unknown): Promise<void> {
  const s = stats as Record<string, unknown>;
  const payload = {
    jsonrpc: "2.0",
    method: "metrics.ingest",
    params: {
      session_id: str(s.session_id),
      agent_id: str(s.agent_id),
      step_id: str(s.step_id),
      tier_rule: str(s.tier_rule),
      prompt_tokens: num(s.prompt_tokens),
      completion_tokens: num(s.completion_tokens),
      cached_tokens: num(s.cached_tokens),
      cache_hit_rate: num(s.cache_hit_rate),
      turn_count: num(s.turn_count),
    },
    id: 1,
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    /* metrics are best-effort; never block a step */
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
