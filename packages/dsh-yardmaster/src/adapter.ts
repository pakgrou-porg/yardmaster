// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import type { YardmasterPluginConfig } from "./config.js";

/**
 * Correlation headers set on every request the adapter makes to the data plane.
 * The data plane uses `X-Yardmaster-Tier` as the `plan_execute` client hint and
 * records the session/agent/step ids on the metrics event (spec 1.10).
 */
export interface YardmasterHeaders {
  "X-Yardmaster-Tier"?: "planner" | "worker";
  "X-Yardmaster-Session": string;
  "X-Yardmaster-Agent": string;
  "X-Yardmaster-Step": string;
}

/**
 * The `yardmaster` LLM adapter.
 *
 * Speaks to the Yardmaster data plane on loopback
 * (`http://127.0.0.1:1234/v1` by default; the Anthropic ingress on `:4000` when
 * the selected route prefers it) and implements the dsh adapter seam per
 * `docs/cookbook/adding-an-llm-adapter.md`: streaming, tool calls, and usage
 * reporting, with the protocol obligations (emit `usage` before `finish`, raw
 * JSON tool arguments, first-seen block index order, `options.signal` honored,
 * `UNSUPPORTED_OPTION` on options it cannot pass through).
 *
 * It never holds a provider API key — Yardmaster does.
 *
 * This is a scaffold: the streaming translation between dsh `StreamChunk` and
 * the data plane's OpenAI/Anthropic SSE is tracked by a `blocked` issue.
 */
export class YardmasterAdapter {
  constructor(private readonly config: YardmasterPluginConfig) {}

  /** Build the correlation headers for a step. */
  headersFor(ids: {
    sessionId: string;
    agentId: string;
    stepId: string;
    tier?: "planner" | "worker";
  }): YardmasterHeaders {
    const h: YardmasterHeaders = {
      "X-Yardmaster-Session": ids.sessionId,
      "X-Yardmaster-Agent": ids.agentId,
      "X-Yardmaster-Step": ids.stepId,
    };
    if (ids.tier) h["X-Yardmaster-Tier"] = ids.tier;
    return h;
  }

  /**
   * Resolve the base URL for a request. Routes that prefer Anthropic Messages
   * are served from `:4000`; everything else from the OpenAI-compatible ingress.
   */
  baseUrlFor(prefersAnthropic: boolean): string {
    return prefersAnthropic ? this.config.anthropicEndpoint : this.config.endpoint;
  }

  // async *stream(options): AsyncIterable<StreamChunk> { ... }  // tracked: blocked issue
}
