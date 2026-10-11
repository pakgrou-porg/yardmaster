// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * The routing engine. Pure functions over a parsed `yardmaster.toml`:
 * pick a target for a requested model, resolve its provider endpoint + key,
 * and honour `[egress]`. No I/O here — `server.mjs` does the forwarding.
 *
 * Supported route types: `passthrough`, `escalation` (weak -> strong on
 * upstream failure), `random` (weighted), and `llm_classifier` in capability
 * mode (a judge picks weak or strong; ADR-0030, see classifier.mjs). A request
 * whose `model` equals a route's `id` runs that route. A model id that matches
 * a `[targets.*].id` is routed directly (zero-config pass-through) first.
 * Everything else (stage_router, plan_execute, …) is the Rust data plane's
 * job — repo issue #36 — and passes through to the route's `target`.
 *
 * Replicas (ADR-0029): several `[targets.*]` may declare the same `id` — the
 * same model served from different nodes (one GB10, the other GB10, or both
 * spanned over their dedicated fabric). A hop for that id becomes an ordered
 * chain over every replica (declaration order, last-known-unreachable ones
 * last), so a node that is down or busy fails over to the next. A `remote`
 * replica only ever joins a chain whose primary is itself `remote`: failover
 * never moves a prompt off the LAN on its own.
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
    return {
      ok: false,
      errors: [`TOML parse error: ${e.message}`],
      providers: {},
      targets: {},
      routes: {},
      egress: {},
      harness: {},
      nodes: {},
    };
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
  const harness = doc.harness && typeof doc.harness === "object" ? doc.harness : {};
  const nodes = {};
  for (const [k, v] of Object.entries(doc.nodes ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) nodes[k] = v;
  }
  return { ok: true, errors: [], providers, targets, routes, egress, harness, nodes };
}

/** `cluster` | `lan` | `remote` -> is egress to it allowed by `[egress]`? */
export function egressAllowed(locality, egress) {
  if (locality === "remote") return egress.allow_remote === true;
  if (locality === "lan") return egress.allow_lan !== false;
  return true; // cluster / unset
}

/** Resolve a `[providers.*]` entry to its base URL / key / kind. Exported for
 * the capability-registry prober (`capabilities.mjs`), which probes every
 * provider a target references the same way the request path does. */
export function providerEndpoint(providerName, providers) {
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

/**
 * Where a provider's engine physically runs (ADR-0029): the `[nodes.*]` its
 * `nodes = [...]` list names, summarized. `span` is "multi" for one engine
 * sharded across several nodes (e.g. vLLM tensor-parallel over the GB10s'
 * QSFP link), "single" otherwise. `fabric` is the interconnect the nodes
 * share, or null when they don't share one. Null when the provider declares
 * no nodes (cloud providers, or a config that predates `[nodes]`).
 */
export function providerPlacement(providerName, config) {
  const p = config.providers?.[providerName];
  const names = Array.isArray(p?.nodes) ? p.nodes.filter((n) => typeof n === "string" && n) : [];
  if (!names.length) return null;
  const known = names.map((n) => config.nodes?.[n]).filter(Boolean);
  const fabrics = new Set(known.map((n) => (typeof n.fabric === "string" && n.fabric ? n.fabric : null)));
  const memory = known.map((n) => n.memory_gb).filter(Number.isFinite);
  return {
    nodes: names,
    span: names.length > 1 ? "multi" : "single",
    accelerators: [...new Set(known.map((n) => n.accelerator).filter((a) => typeof a === "string" && a))],
    memory_gb: memory.length ? memory.reduce((a, b) => a + b, 0) : null,
    fabric: names.length > 1 && fabrics.size === 1 ? [...fabrics][0] : null,
  };
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
    nodes: providerPlacement(t.provider, config)?.nodes ?? null,
  };
}

/**
 * Every target serving the same model id as `name` (ADR-0029 replicas), as
 * resolved hops: `name` first, then the others in declaration order, then any
 * whose last probe said unreachable moved to the back (still tried — a probe
 * can be up to one reconcile interval stale). `health` is an optional
 * `Map<targetName, reachability>` from the capability registry.
 */
function replicaHops(name, config, health) {
  const t = config.targets[name];
  if (!t) return { error: `target "${name}" is not defined` };
  const primaryRemote = (t.locality || "cluster") === "remote";
  const names = [name];
  for (const [n, other] of Object.entries(config.targets)) {
    if (n === name || other?.id !== t.id) continue;
    if (!primaryRemote && other.locality === "remote") continue; // never fail over off the LAN
    names.push(n);
  }
  const hops = [];
  let firstError = null;
  for (const n of names) {
    const hop = resolveTarget(n, config);
    if (hop.error) firstError ??= hop.error;
    else hops.push(hop);
  }
  if (!hops.length) return { error: firstError };
  const down = (h) => health?.get(h.targetName) === "unreachable";
  return { hops: [...hops.filter((h) => !down(h)), ...hops.filter(down)] };
}

/**
 * Decide where a request for `requestedModel` goes.
 * Returns `{ ok, chain, routeName, algorithm, decisionReason }` or `{ ok:false, error }`.
 * `chain` is the ordered list of hops to try (1 for passthrough/direct, 2 for escalation).
 */
export function resolveRoute(config, requestedModel, { health, random } = {}) {
  const model = String(requestedModel || "").trim();

  // 1) direct model-id match -> that target and its replicas (zero-config pass-through).
  if (model) {
    for (const [name, t] of Object.entries(config.targets)) {
      if (t.id === model) {
        const r = replicaHops(name, config, health);
        if (r.error) return { ok: false, error: r.error };
        return {
          ok: true,
          chain: r.hops.map((hop) => ({ ...hop, model })),
          routeName: "model-name",
          algorithm: "passthrough",
          decisionReason: "model-name",
        };
      }
    }
    // 2) a named route (ADR-0030): Switchyard's convention, the request's
    //    `model` is a route `id` — `"model": "classified"` runs the route whose
    //    id is "classified". A target id of the same name wins (step 1).
    for (const route of Object.values(config.routes || {})) {
      if (route && typeof route === "object" && route.id === model) return evaluateRoute(route, config, { health, random });
    }
  }

  // 3) fall through to the default route.
  const route = config.routes.default;
  if (!route) {
    return { ok: false, error: `model "${model}" matches no target and there is no [routes.default]` };
  }
  return evaluateRoute(route, config, { health, random });
}

// Seeded generators for `random` routes with a `seed`, keyed by route id +
// seed so a config reload with a new seed starts a fresh sequence.
const seededRngs = new Map();
function seededRandom(key, seed) {
  if (!seededRngs.has(key)) {
    let a = seed >>> 0;
    seededRngs.set(key, () => {
      // mulberry32
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    });
  }
  return seededRngs.get(key)();
}

/** Weighted pick of one target name; weights default to equal. */
export function pickWeighted(targets, weights, r) {
  const w = targets.map((_, i) => (Number.isFinite(weights?.[i]) && weights[i] > 0 ? weights[i] : weights ? 0 : 1));
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return targets[0];
  let x = r * total;
  for (let i = 0; i < targets.length; i++) {
    x -= w[i];
    if (x < 0) return targets[i];
  }
  return targets[targets.length - 1];
}

function evaluateRoute(route, config, { health, random }) {
  const type = route.type || "passthrough";
  const routeName = route.id || "default";

  if (type === "escalation") {
    const weak = replicaHops(route.weak_target, config, health);
    const strong = replicaHops(route.strong_target, config, health);
    if (weak.error && strong.error) return { ok: false, error: `escalation route: ${weak.error}; ${strong.error}` };
    const chain = [];
    for (const hop of weak.hops || []) chain.push({ ...hop, escalated: false });
    for (const hop of strong.hops || []) chain.push({ ...hop, escalated: true });
    return { ok: true, chain, routeName, algorithm: "escalation", decisionReason: "escalation" };
  }

  if (type === "random" && Array.isArray(route.targets) && route.targets.length) {
    const r = Number.isInteger(route.seed) ? seededRandom(`${routeName}:${route.seed}`, route.seed) : (random ?? Math.random)();
    const picked = pickWeighted(route.targets, Array.isArray(route.weights) ? route.weights : null, r);
    const hops = replicaHops(picked, config, health);
    if (hops.error) return { ok: false, error: `random route: ${hops.error}` };
    return { ok: true, chain: hops.hops, routeName, algorithm: "random", decisionReason: `random:${picked}` };
  }

  if (type === "llm_classifier") {
    const weak = replicaHops(route.weak_target, config, health);
    const strong = replicaHops(route.strong_target, config, health);
    if (weak.error && strong.error) return { ok: false, error: `llm_classifier route: ${weak.error}; ${strong.error}` };
    const weakChain = weak.hops || [];
    const strongChain = (strong.hops || []).map((h) => ({ ...h, escalated: true }));
    if ((route.mode ?? "capability") !== "capability") {
      // Escalation mode (judge the weak answer, then maybe retry strong) is
      // not ported; degrade to failure-based weak -> strong, like `escalation`.
      return {
        ok: true,
        chain: [...weakChain, ...strongChain],
        routeName,
        algorithm: "llm_classifier",
        decisionReason: `llm_classifier(${route.mode}):failover`,
      };
    }
    let judge = null;
    let judgeError = null;
    const j = route.classifier_target ? resolveTarget(route.classifier_target, config) : { error: "no classifier_target" };
    if (j.error) judgeError = "judge target unusable";
    else if (j.locality === "remote" && route.judge_egress !== "allow") judgeError = "judge_egress denies a remote judge";
    else judge = j;
    return {
      ok: true,
      // Fail-open default until the judge answers: the strong tier.
      chain: strongChain.length ? strongChain : weakChain,
      routeName,
      algorithm: "llm_classifier",
      decisionReason: "llm_classifier:pending",
      classify: {
        judge,
        judgeError,
        weakChain,
        strongChain,
        thresholds: { base_threshold: route.base_threshold, threshold_step: route.threshold_step },
        maxTokens: Number.isInteger(route.max_output_tokens) && route.max_output_tokens > 0 ? route.max_output_tokens : undefined,
      },
    };
  }

  // passthrough (and anything not implemented here -> passthrough to `target`).
  const tgt = route.target;
  if (!tgt) return { ok: false, error: `route "${routeName}" type="${type}" needs a target this router understands` };
  const r = replicaHops(tgt, config, health);
  if (r.error) return { ok: false, error: r.error };
  return {
    ok: true,
    chain: r.hops,
    routeName,
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
