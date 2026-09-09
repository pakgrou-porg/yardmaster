// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * The routing engine. Pure functions over a parsed `yardmaster.toml`:
 * pick a target for a requested model, resolve its provider endpoint + key,
 * and honour `[egress]`. No I/O here — `server.mjs` does the forwarding.
 *
 * Supported route types: `passthrough` and `escalation` (weak -> strong on
 * upstream failure). A model id that matches a `[targets.*].id` is routed
 * directly (zero-config pass-through), regardless of the default route.
 * Everything else (stage_router, llm_classifier, plan_execute, …) is the Rust
 * data plane's job — repo issue #36 — and falls back to the default target.
 */

import { parse as parseToml } from "smol-toml";

// Keyed cloud providers carry no base_url in config; this is their API root.
export const KEYED_DEFAULT_BASE = {
  openrouter: "https://openrouter.ai/api/v1",
  venice: "https://api.venice.ai/api/v1",
  kie: "https://api.kie.ai/v1",
};

const KEYED_KINDS = new Set(Object.keys(KEYED_DEFAULT_BASE));

/** Parse + normalise. Returns `{ ok, errors, providers, targets, routes, egress }`. */
export function parseConfig(rawText) {
  let doc;
  try {
    doc = parseToml(rawText || "");
  } catch (e) {
    return { ok: false, errors: [`TOML parse error: ${e.message}`], providers: {}, targets: {}, routes: {}, egress: {} };
  }
  const providers = doc.providers ?? {};
  const targets = {};
  for (const [k, v] of Object.entries(doc.targets ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) targets[k] = v;
  }
  const routes = doc.routes ?? {};
  const egress = {
    allow_remote: (doc.egress ?? {}).allow_remote === true,
    allow_lan: (doc.egress ?? {}).allow_lan !== false, // default true
  };
  return { ok: true, errors: [], providers, targets, routes, egress };
}

/** `cluster` | `lan` | `remote` -> is egress to it allowed by `[egress]`? */
export function egressAllowed(locality, egress) {
  if (locality === "remote") return egress.allow_remote === true;
  if (locality === "lan") return egress.allow_lan !== false;
  return true; // cluster / unset
}

function providerEndpoint(providerName, providers) {
  const p = providers[providerName];
  if (!p) return { error: `provider "${providerName}" is not defined` };
  const kind = p.kind || "openai_compatible";
  let baseUrl = typeof p.base_url === "string" && p.base_url ? p.base_url.replace(/\/+$/, "") : "";
  if (!baseUrl && KEYED_DEFAULT_BASE[kind]) baseUrl = KEYED_DEFAULT_BASE[kind];
  if (!baseUrl) return { error: `provider "${providerName}" has no base_url` };
  let apiKey = "";
  if (typeof p.api_key_env === "string" && p.api_key_env) apiKey = process.env[p.api_key_env] || "";
  if (KEYED_KINDS.has(kind) && !apiKey) {
    return { error: `provider "${providerName}": ${p.api_key_env || "api key"} is not set in the environment` };
  }
  const engineKind = KEYED_KINDS.has(kind) ? "provider" : kind;
  // OpenAI Chat Completions lives at <root>/v1/chat/completions. `base_url` may
  // already include /v1 (LAN vLLM style) or not (bare Ollama style) — handle both.
  const chatUrl = /\/v1$/.test(baseUrl)
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;
  return { baseUrl, chatUrl, apiKey, kind, engineKind };
}

/** Resolve one `[targets.*]` name into a concrete hop, or `{ error }`. */
function resolveTarget(name, config) {
  const t = config.targets[name];
  if (!t) return { error: `target "${name}" is not defined` };
  const locality = t.locality || "cluster";
  if (!egressAllowed(locality, config.egress)) {
    return { error: `target "${name}" is locality="${locality}" but [egress] forbids it` };
  }
  const ep = providerEndpoint(t.provider, config.providers);
  if (ep.error) return { error: ep.error };
  return {
    targetName: name,
    model: t.id,
    locality,
    provider: t.provider,
    baseUrl: ep.baseUrl,
    chatUrl: ep.chatUrl,
    apiKey: ep.apiKey,
    engineKind: ep.engineKind,
    extraBody: t.extra_body && typeof t.extra_body === "object" ? t.extra_body : null,
    extraHeaders: t.extra_headers && typeof t.extra_headers === "object" ? t.extra_headers : null,
  };
}

/**
 * Decide where a request for `requestedModel` goes.
 * Returns `{ ok, chain, routeName, algorithm, decisionReason }` or `{ ok:false, error }`.
 * `chain` is the ordered list of hops to try (1 for passthrough/direct, 2 for escalation).
 */
export function resolveRoute(config, requestedModel) {
  const model = String(requestedModel || "").trim();

  // 1) direct model-id match -> that target (zero-config pass-through).
  if (model) {
    for (const [name, t] of Object.entries(config.targets)) {
      if (t.id === model) {
        const hop = resolveTarget(name, config);
        if (hop.error) return { ok: false, error: hop.error };
        return {
          ok: true,
          chain: [{ ...hop, model }],
          routeName: "model-name",
          algorithm: "passthrough",
          decisionReason: "model-name",
        };
      }
    }
  }

  // 2) fall through to the default route.
  const route = config.routes.default;
  if (!route) {
    return { ok: false, error: `model "${model}" matches no target and there is no [routes.default]` };
  }
  const type = route.type || "passthrough";

  if (type === "escalation") {
    const weak = resolveTarget(route.weak_target, config);
    const strong = resolveTarget(route.strong_target, config);
    if (weak.error && strong.error) return { ok: false, error: `escalation route: ${weak.error}; ${strong.error}` };
    const chain = [];
    if (!weak.error) chain.push({ ...weak, model: weak.model });
    if (!strong.error) chain.push({ ...strong, model: strong.model });
    return { ok: true, chain, routeName: route.id || "default", algorithm: "escalation", decisionReason: "escalation" };
  }

  // passthrough (and anything not implemented here -> passthrough to `target`).
  const tgt = route.target;
  if (!tgt) return { ok: false, error: `[routes.default] type="${type}" needs a target this router understands` };
  const hop = resolveTarget(tgt, config);
  if (hop.error) return { ok: false, error: hop.error };
  return {
    ok: true,
    chain: [{ ...hop, model: hop.model }],
    routeName: route.id || "default",
    algorithm: type === "passthrough" ? "passthrough" : `passthrough(${type})`,
    decisionReason: type === "passthrough" ? "passthrough" : `fallback-from-${type}`,
  };
}

/** Every model id the router can serve (for /v1/models and /api/tags). */
export function knownModels(config) {
  const out = new Set();
  for (const t of Object.values(config.targets)) if (t.id) out.add(t.id);
  return [...out];
}

/**
 * Pull token usage (and cost, if the provider reports it) out of a chat
 * response body. Handles a whole-body JSON object (non-stream) and SSE / NDJSON
 * (last object carrying `usage` wins). A real JSON parse — a regex breaks on the
 * nested `*_details` sub-objects OpenAI / OpenRouter / vLLM emit.
 */
export function sniffUsage(text) {
  const out = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: null, cost: null };
  if (!text) return out;
  const take = (u) => {
    if (!u || typeof u !== "object") return;
    out.prompt_tokens = u.prompt_tokens ?? u.input_tokens ?? out.prompt_tokens;
    out.completion_tokens = u.completion_tokens ?? u.output_tokens ?? out.completion_tokens;
    out.cached_tokens =
      u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? out.cached_tokens;
    if (typeof u.cost === "number") out.cost = u.cost;
  };
  try {
    take(JSON.parse(text.trim()).usage);
    if (out.prompt_tokens || out.completion_tokens) return out;
  } catch {
    /* not one JSON object — fall through to a line scan */
  }
  for (const raw of text.split("\n")) {
    const line = raw.startsWith("data:") ? raw.slice(5).trim() : raw.trim();
    if (!line || line === "[DONE]" || line[0] !== "{") continue;
    try {
      const j = JSON.parse(line);
      if (j.usage) take(j.usage);
    } catch {
      /* partial chunk */
    }
  }
  return out;
}
