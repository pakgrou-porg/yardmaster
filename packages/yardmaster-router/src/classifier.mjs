// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * `llm_classifier` (capability mode) for the interim router (ADR-0030): a small
 * judge model forecasts whether the weak ("efficient") target would solve the
 * task, and the route picks weak or strong from that forecast. A port of
 * Switchyard's `llm_task_classifier` (libsy/src/algorithms/llm_class.rs):
 * same prompt, same response schema, same verdict validation and threshold
 * rule, and the same fail-open default (anything other than a valid verdict
 * routes to the strong target).
 *
 * The judge sees request content, so it inherits every content rule: nothing
 * here logs or returns prompt text or the judge's `crux` (which paraphrases
 * the task). Only `p_solve`, the rule id and the boundary leave this module.
 *
 * Everything except `runJudge` is pure.
 */

import { CAPABILITY_PROMPT, CAPABILITY_RESPONSE_FORMAT } from "./classifier-prompt.mjs";

const VALID_RULES = {
  supported: new Set(["SUP-1", "SUP-2", "SUP-3", "SUP-4", "SUP-5"]),
  uncertain: new Set(["UNC-1", "UNC-2"]),
  unsupported: new Set(["LIM-1", "LIM-2"]),
  unmatched: new Set(["none"]),
};
const BOUNDARY_STEPS = { supported: 0, uncertain: 1, unmatched: 1, unsupported: 2 };

export const DEFAULT_BASE_THRESHOLD = 0.5;
export const DEFAULT_THRESHOLD_STEP = 0.1;
export const DEFAULT_JUDGE_MAX_TOKENS = 512;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/**
 * What the judge is shown: the opening user instruction and, when there is a
 * later one, the latest user follow-up (Switchyard's default `task_messages`
 * path). Text only — tool traffic, assistant turns and system prompts are
 * dropped. Non-text parts (images) are dropped too, unlike upstream, because
 * a small local judge usually can't take them.
 */
export function taskMessages(messages) {
  const users = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === "user")
    .map((m) => textOf(m.content))
    .filter((t) => t.trim() !== "");
  if (!users.length) return [];
  const picked = users.length > 1 ? [users[0], users[users.length - 1]] : [users[0]];
  return picked.map((content) => ({ role: "user", content }));
}

/** The OpenAI chat body sent to the judge target. */
export function buildJudgeRequest(model, messages, { maxTokens = DEFAULT_JUDGE_MAX_TOKENS } = {}) {
  return {
    model,
    messages: [{ role: "system", content: CAPABILITY_PROMPT }, ...taskMessages(messages)],
    response_format: CAPABILITY_RESPONSE_FORMAT,
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
  };
}

/**
 * Parse and validate the judge's reply. Judge output is untrusted: anything
 * that isn't exactly the schema's four fields with a consistent rule/boundary
 * pair and p_solve in [0,1] is `null` (ambiguous). Tolerates a reasoning
 * model's `<think>` block and a markdown code fence around the object.
 */
export function parseVerdict(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let v;
  try {
    v = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v).sort().join(",");
  if (keys !== "capability_boundary,crux,p_solve,primary_rule") return null;
  if (typeof v.crux !== "string" || !v.crux.trim()) return null;
  if (typeof v.p_solve !== "number" || !(v.p_solve >= 0 && v.p_solve <= 1)) return null;
  if (!VALID_RULES[v.capability_boundary]?.has(v.primary_rule)) return null;
  return { p_solve: v.p_solve, primary_rule: v.primary_rule, capability_boundary: v.capability_boundary };
}

/**
 * Switchyard's threshold rule: threshold = base + steps(boundary) * step;
 * p_solve at or above it routes to the weak (efficient) target, below it to
 * the strong one. No valid verdict -> strong (fail open).
 */
export function decideTier(verdict, { base_threshold, threshold_step } = {}) {
  const base = Number.isFinite(base_threshold) ? base_threshold : DEFAULT_BASE_THRESHOLD;
  const step = Number.isFinite(threshold_step) ? threshold_step : DEFAULT_THRESHOLD_STEP;
  if (!verdict) return { tier: "strong", reason: "ambiguous" };
  const threshold = base + BOUNDARY_STEPS[verdict.capability_boundary] * step;
  const weak = verdict.p_solve >= threshold || Math.abs(threshold - verdict.p_solve) <= Number.EPSILON;
  return {
    tier: weak ? "weak" : "strong",
    reason: "judge",
    p_solve: verdict.p_solve,
    rule: verdict.primary_rule,
    boundary: verdict.capability_boundary,
    threshold: Math.round(threshold * 1000) / 1000,
  };
}

/** One non-streaming call to the judge hop. Returns `{ ok, content }` or `{ ok:false, error }`. */
export async function runJudge(hop, body, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json", ...(hop.extraHeaders || {}) };
    if (hop.apiKey) headers.authorization = `Bearer ${hop.apiKey}`;
    const r = await fetchImpl(hop.chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, ...(hop.extraBody || {}) }),
      signal: ac.signal,
    });
    if (!r.ok) return { ok: false, error: `judge HTTP ${r.status}` };
    const j = await r.json();
    return { ok: true, content: j.choices?.[0]?.message?.content ?? "" };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? `judge timeout after ${timeoutMs}ms` : "judge unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a decision `resolveRoute` left pending (`decided.classify`): run the
 * judge, pick the weak or strong chain, and return the updated decision plus a
 * content-free summary for headers and metrics.
 */
export async function classify(decided, payload, opts = {}) {
  const c = decided.classify;
  let outcome;
  if (!c.judge) {
    outcome = { tier: "strong", reason: c.judgeError || "no judge" };
  } else {
    const body = buildJudgeRequest(c.judge.model, payload.messages, { maxTokens: c.maxTokens });
    const res = await runJudge(c.judge, body, opts);
    outcome = res.ok ? decideTier(parseVerdict(res.content), c.thresholds) : { tier: "strong", reason: res.error };
  }
  let chain = outcome.tier === "weak" ? c.weakChain : c.strongChain;
  // A tier with no usable hop falls back to the other one rather than failing.
  if (!chain.length) chain = outcome.tier === "weak" ? c.strongChain : c.weakChain;
  return { ...decided, chain, decisionReason: `llm_classifier:${outcome.tier}`, classification: outcome };
}

/** `x-yardmaster-classifier` header value — numbers and ids only, never content. */
export function classificationHeader(o) {
  const parts = [`tier=${o.tier}`, `reason=${String(o.reason).replace(/[^\w .:-]/g, "")}`];
  if (o.p_solve != null) parts.push(`p_solve=${o.p_solve}`, `threshold=${o.threshold}`, `rule=${o.rule}`, `boundary=${o.boundary}`);
  return parts.join("; ");
}
