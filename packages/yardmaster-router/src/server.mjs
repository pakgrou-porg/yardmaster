// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * yardmaster-router — the interim inference data plane (repo issue #36 replaces
 * it with the Rust `yardmaster-dataplane`). Config-driven routing of OpenAI /
 * Ollama chat requests to local / LAN / OpenRouter backends by model id, with
 * `passthrough` + `escalation` routes, streaming, and metrics.
 *
 * Endpoints:
 *   GET  /healthz
 *   GET  /v1/models                 every routable model id
 *   POST /v1/chat/completions       OpenAI Chat Completions (stream + non-stream)
 *   GET  /api/tags                  Ollama-style model list
 *   POST /api/chat                  Ollama chat (translated to/from OpenAI)
 *   GET  /v1/capabilities           the capability registry (ADR-0028 P1)
 *   POST /v1/capabilities/reconcile run the pipeline now
 *   POST /v1/capabilities/apply     approve every held (pending) op
 *
 * Env: YM_ROUTER_PORT (4000), YM_ROUTER_BIND (127.0.0.1),
 *      YM_ROUTER_CONFIG (/config/yardmaster.toml),
 *      YM_CONFIG_FALLBACK ("/data/Nvidia Corporation/Personal AI Router/yardmaster.toml"),
 *      YM_METRICS_DB (same default dir).
 *
 * Capability registry (ADR-0028 P1) — discovers the Harness's model list from
 * yardmaster.toml + live provider probes and writes it into a delimited region
 * of $DSH_HOME/profiles/web/cordis.patch.yml (dsh hot-reloads it):
 *   YM_HARNESS_DSH_HOME (/dshhome), YM_DSH_BIN (the dsh CLI, for the
 *   `--dump-config` gate before every write), YM_HARNESS_UPSTREAM (derived
 *   from YM_ROUTER_PORT), YM_HARNESS_DEFAULT_MODEL (fallback for
 *   [harness].default_model), YM_CAPABILITIES_RECONCILE_S (60),
 *   YM_CAPABILITIES_PROBE_TIMEOUT_MS (4000).
 */

import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseConfig, resolveRoute, knownModels, sniffUsage } from "./router.mjs";
import { openMetrics } from "./metrics.mjs";
import {
  parseHarnessConfig,
  probeCapabilitySources,
  runPipeline,
  writeManagedRegion,
  makeDshValidator,
  parseAppliedRegion,
} from "./capabilities.mjs";

const cfg = {
  port: Number(process.env.YM_ROUTER_PORT || 4000),
  bind: process.env.YM_ROUTER_BIND || "127.0.0.1",
  configPath: process.env.YM_ROUTER_CONFIG || "/config/yardmaster.toml",
  fallbackConfigPath:
    process.env.YM_CONFIG_FALLBACK || "/data/Nvidia Corporation/Personal AI Router/yardmaster.toml",
  metricsDb:
    process.env.YM_METRICS_DB || "/data/Nvidia Corporation/Personal AI Router/yardmaster-metrics.db",
  upstreamTimeoutMs: Number(process.env.YM_ROUTER_TIMEOUT_MS || 300000),
  // Transient upstream errors (429 rate-limit, 503, …) are retried on the same
  // hop with backoff before failing over / surfacing. Agent loops hit provider
  // rate limits hard; this smooths them so the client rarely sees a 429.
  retryMax: Number(process.env.YM_ROUTER_RETRY || 4),
  retryBaseMs: Number(process.env.YM_ROUTER_RETRY_BASE_MS || 600),
};

// Capability-registry pipeline (ADR-0028 P1) — Harness model discovery. Off by
// default unless the Harness's DSH_HOME is actually mounted here.
const capCfg = {
  dshHome: process.env.YM_HARNESS_DSH_HOME || "/dshhome",
  dshBin: process.env.YM_DSH_BIN || "/opt/yardmaster/node_modules/@deepseek-ai/dsh/lib/bin.js",
  upstream: process.env.YM_HARNESS_UPSTREAM || `http://127.0.0.1:${Number(process.env.YM_ROUTER_PORT || 4000)}/v1`,
  reconcileIntervalMs: Number(process.env.YM_CAPABILITIES_RECONCILE_S || 60) * 1000,
  probeTimeoutMs: Number(process.env.YM_CAPABILITIES_PROBE_TIMEOUT_MS || 4000),
};
capCfg.patchPath = `${capCfg.dshHome}/profiles/web/cordis.patch.yml`;

const metrics = openMetrics(cfg.metricsDb);

// --- config load + hot reload --------------------------------------------
let config = { ok: false, errors: ["not loaded"], providers: {}, targets: {}, routes: {}, egress: {}, harness: {} };
let loadedFrom = null;
let loadedMtime = 0;

function activePath() {
  if (existsSync(cfg.configPath)) return cfg.configPath;
  if (existsSync(cfg.fallbackConfigPath)) return cfg.fallbackConfigPath;
  return null;
}

// --- capability registry (ADR-0028 P1) -------------------------------------
// Declared before loadConfig()'s first (synchronous, module-load-time) call
// below, which calls scheduleReconcile() as soon as a config parses — that
// would otherwise read `reconcileTimer` while it's still in the temporal
// dead zone.
let registry = {
  records: new Map(),
  desired: null,
  plan: { appliedEntries: [], appliedDefaultId: null, pendingOps: [] },
  lastReconcileMs: 0,
  lastError: null,
};
let previousApplied = existsSync(capCfg.patchPath) ? parseAppliedRegion(readFileSync(capCfg.patchPath, "utf8") || "") : null;
const dshValidator = makeDshValidator({ dshBin: existsSync(capCfg.dshBin) ? capCfg.dshBin : null, dshHome: capCfg.dshHome });
let reconcileTimer = null;
let reconciling = false;

function loadConfig(force = false) {
  const p = activePath();
  if (!p) {
    if (loadedFrom !== null || force) console.error("yardmaster-router: no yardmaster.toml found");
    config = { ok: false, errors: ["no yardmaster.toml"], providers: {}, targets: {}, routes: {}, egress: {}, harness: {} };
    loadedFrom = null;
    return;
  }
  let mtime = 0;
  try {
    mtime = statSync(p).mtimeMs;
  } catch {
    /* race */
  }
  if (!force && p === loadedFrom && mtime === loadedMtime) return;
  try {
    config = parseConfig(readFileSync(p, "utf8"));
    loadedFrom = p;
    loadedMtime = mtime;
    const n = Object.keys(config.targets).length;
    console.log(
      `yardmaster-router: loaded ${p} — ${n} target(s), egress remote=${config.egress.allow_remote} lan=${config.egress.allow_lan}` +
        (config.ok ? "" : ` [errors: ${config.errors.join("; ")}]`),
    );
    scheduleReconcile();
  } catch (e) {
    console.error(`yardmaster-router: failed to read ${p}: ${e.message}`);
  }
}
loadConfig(true);
setInterval(() => loadConfig(false), 3000).unref();

async function reconcileNow() {
  if (reconciling) return; // coalesce overlapping triggers
  if (!config.ok || Object.keys(config.targets).length === 0) return;
  reconciling = true;
  try {
    const harnessCfg = parseHarnessConfig(config);
    // [harness].default_model in yardmaster.toml is the source of truth; this
    // env var is only a fallback for operators who haven't set it there yet.
    if (!harnessCfg.defaultModel && process.env.YM_HARNESS_DEFAULT_MODEL) {
      harnessCfg.defaultModel = process.env.YM_HARNESS_DEFAULT_MODEL;
    }
    const probeMap = await probeCapabilitySources(config, { timeoutMs: capCfg.probeTimeoutMs });
    const { records, desired, plan } = runPipeline(config, probeMap, harnessCfg, previousApplied);
    registry = { records, desired, plan, lastReconcileMs: Date.now(), lastError: null };

    if (!existsSync(capCfg.dshHome)) return; // no Harness volume mounted here — registry still computed, nothing to write

    const result = await writeManagedRegion({
      patchPath: capCfg.patchPath,
      entries: plan.appliedEntries,
      defaultId: plan.appliedDefaultId,
      upstream: capCfg.upstream,
      validate: dshValidator,
    });
    if (result.applied) {
      previousApplied = { entries: plan.appliedEntries, defaultId: plan.appliedDefaultId };
      console.log(
        `yardmaster-router: capabilities applied — ${plan.appliedEntries.length} model(s), default=${plan.appliedDefaultId}` +
          (plan.pendingOps.length ? `, ${plan.pendingOps.length} pending op(s) held` : ""),
      );
    } else if (result.error) {
      registry.lastError = result.error;
      console.error(
        `yardmaster-router: capabilities write rejected by dsh --dump-config (rolled back to last-known-good): ${result.error.slice(0, 500)}`,
      );
    }
  } catch (e) {
    registry.lastError = String(e.message || e);
    console.error(`yardmaster-router: capabilities reconcile failed: ${registry.lastError}`);
  } finally {
    reconciling = false;
  }
}
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(reconcileNow, 500).unref(); // debounce rapid config saves
}
setInterval(reconcileNow, capCfg.reconcileIntervalMs).unref();
scheduleReconcile();

/** POST /v1/capabilities/apply — approve every held (pending) op: write the
 * full "desired" state (what the registry computed with nothing withheld). */
async function forceApplyPending() {
  if (!registry.desired) return { applied: false, error: "no registry computed yet" };
  if (!existsSync(capCfg.dshHome)) return { applied: false, error: "no Harness volume mounted here" };
  const result = await writeManagedRegion({
    patchPath: capCfg.patchPath,
    entries: registry.desired.entries,
    defaultId: registry.desired.defaultId,
    upstream: capCfg.upstream,
    validate: dshValidator,
  });
  if (result.applied || result.unchanged) {
    previousApplied = { entries: registry.desired.entries, defaultId: registry.desired.defaultId };
    registry.plan = { appliedEntries: registry.desired.entries, appliedDefaultId: registry.desired.defaultId, pendingOps: [] };
  }
  return result;
}

// --- helpers ------------------------------------------------------------
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const c = [];
    let n = 0;
    req.on("data", (d) => {
      n += d.length;
      if (n > 32 * 1024 * 1024) reject(new Error("body too large"));
      else c.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
    req.on("error", reject);
  });
const json = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
};
const isLoopback = (a) => !a || a === "127.0.0.1" || a === "::1" || a.startsWith("::ffff:127.");

function baseMetricRow(req, ingressProtocol) {
  return {
    request_id: randomUUID(),
    ts_ms: Date.now(),
    client_ingress_protocol: ingressProtocol,
    client_ingress_port: cfg.port,
    client_identity: isLoopback(req.socket?.remoteAddress) ? "loopback" : "non-loopback",
    candidate_set_size: 1,
    failover_count: 0,
    tier_decided: (req.headers["x-yardmaster-tier"] || "worker").toString(),
    stream: 0,
    session_id: req.headers["x-yardmaster-session"]?.toString() || null,
    agent_id: req.headers["x-yardmaster-agent"]?.toString() || null,
    step_id: req.headers["x-yardmaster-step"]?.toString() || null,
    tier_rule: null,
    rule: null,
  };
}

const RETRYABLE = new Set([429, 502, 503, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long to wait before a retry: honour Retry-After, else exponential backoff. */
function backoffMs(resp, attempt) {
  const ra = resp?.headers?.get("retry-after");
  if (ra) {
    const secs = /^\d+$/.test(ra.trim()) ? Number(ra) : (Date.parse(ra) - Date.now()) / 1000;
    if (secs > 0) return Math.min(secs * 1000, 30000);
  }
  return Math.min(cfg.retryBaseMs * 2 ** attempt + Math.random() * 250, 20000);
}

/**
 * Try each hop in the chain; retry a hop on a transient status (429/503/…) with
 * backoff before moving on. Returns { upstream, hop, hopIndex, retries } for the
 * first hop that returns a usable response (2xx, or a non-retryable error on the
 * last hop, which is forwarded to the client).
 */
async function dispatch(chain, payload, extraHeaders) {
  let lastErr = "no hop";
  let retries = 0;
  for (let i = 0; i < chain.length; i++) {
    const hop = chain[i];
    const url = hop.chatUrl || `${hop.baseUrl}/v1/chat/completions`;
    const headers = { "content-type": "application/json", ...(hop.extraHeaders || {}), ...(extraHeaders || {}) };
    if (hop.apiKey) headers.authorization = `Bearer ${hop.apiKey}`;
    const body = JSON.stringify({ ...payload, model: hop.model, ...(hop.extraBody || {}) });
    const last = i === chain.length - 1;

    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), cfg.upstreamTimeoutMs);
      try {
        const upstream = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
        clearTimeout(timer);
        if (upstream.ok) return { upstream, hop, hopIndex: i, retries };
        if (RETRYABLE.has(upstream.status) && attempt < cfg.retryMax) {
          const wait = backoffMs(upstream, attempt);
          console.warn(
            `yardmaster-router: ${hop.model} via ${hop.provider} -> ${upstream.status}; retry ${attempt + 1}/${cfg.retryMax} in ${Math.round(wait)}ms`,
          );
          try {
            await upstream.body?.cancel();
          } catch {
            /* ignore */
          }
          retries++;
          await sleep(wait);
          continue;
        }
        if (last) return { upstream, hop, hopIndex: i, retries };
        lastErr = `hop ${i} (${hop.targetName}) -> ${upstream.status}`;
        try {
          await upstream.body?.cancel();
        } catch {
          /* ignore */
        }
        break; // try the next hop
      } catch (e) {
        clearTimeout(timer);
        const why = e.name === "AbortError" ? "timeout" : e.message;
        // A network error / timeout is not a rate limit — fail over to the next
        // hop straight away; only a lone last hop gets one quick retry.
        if (last && attempt < 1 && why !== "timeout") {
          retries++;
          await sleep(cfg.retryBaseMs);
          continue;
        }
        lastErr = `hop ${i} (${hop.targetName}) -> ${why}`;
        if (last) return { error: lastErr, retries };
        break;
      }
    }
  }
  return { error: lastErr, retries };
}

async function handleChat(req, res, { ingress }) {
  const started = Date.now();
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: { message: "invalid JSON body" } });
  }
  const wantStream = payload.stream === true;
  const decided = resolveRoute(config, payload.model);
  const row = baseMetricRow(req, ingress);
  row.model = String(payload.model || "");
  row.stream = wantStream ? 1 : 0;

  if (!decided.ok) {
    row.route = "unrouted";
    row.algorithm = "none";
    row.decision_reason = "no-route";
    row.node_or_provider = "none";
    row.engine_kind = "none";
    row.locality = "lan";
    row.http_status = 502;
    row.error_class = "no_route";
    row.total_latency_ms = Date.now() - started;
    row.routing_overhead_ms = Date.now() - started;
    metrics.record(row);
    return json(res, 502, { error: { message: `yardmaster-router: ${decided.error}` } });
  }

  row.route = decided.routeName;
  row.algorithm = decided.algorithm;
  row.decision_reason = decided.decisionReason;
  row.candidate_set_size = decided.chain.length;

  const passHeaders = {};
  for (const h of ["x-yardmaster-session", "x-yardmaster-agent", "x-yardmaster-step", "x-yardmaster-tier"]) {
    if (req.headers[h]) passHeaders[h] = req.headers[h];
  }

  const routingOverhead = Date.now() - started;
  const result = await dispatch(decided.chain, payload, passHeaders);

  if (result.error || !result.upstream) {
    row.node_or_provider = decided.chain[0]?.provider || "unknown";
    row.engine_kind = decided.chain[0]?.engineKind || "openai_compatible";
    row.locality = decided.chain[0]?.locality || "lan";
    row.failover_count = Math.max(0, decided.chain.length - 1) + (result.retries || 0);
    row.http_status = 502;
    row.error_class = "upstream_unreachable";
    row.total_latency_ms = Date.now() - started;
    row.routing_overhead_ms = routingOverhead;
    metrics.record(row);
    console.warn(`yardmaster-router: ${row.model} -> all upstreams failed after ${result.retries || 0} retries — ${result.error}`);
    return json(res, 502, { error: { message: `yardmaster-router: all upstreams failed — ${result.error}` } });
  }

  const { upstream, hop, hopIndex, retries = 0 } = result;
  row.node_or_provider = hop.provider;
  row.engine_kind = hop.engineKind;
  row.locality = hop.locality;
  row.failover_count = hopIndex + retries;
  row.tier_decided = hopIndex > 0 ? "planner" : row.tier_decided;
  row.http_status = upstream.status;
  row.routing_overhead_ms = routingOverhead;

  // pass upstream status + a curated header set + the routing decision
  const outHeaders = {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "x-yardmaster-route": decided.routeName,
    "x-yardmaster-algorithm": decided.algorithm,
    "x-yardmaster-target": hop.targetName,
    "x-yardmaster-provider": hop.provider,
    "x-yardmaster-locality": hop.locality,
    "x-yardmaster-failover": String(hopIndex),
    "x-yardmaster-retries": String(retries),
  };
  const servedBy = upstream.headers.get("x-served-by");
  if (servedBy) outHeaders["x-served-by"] = servedBy;
  res.writeHead(upstream.status, outHeaders);

  if (!upstream.body) {
    res.end();
    row.total_latency_ms = Date.now() - started;
    row.error_class = upstream.ok ? null : "upstream_error";
    metrics.record(row);
    return;
  }

  // stream/pipe the body through, sniffing usage as it passes.
  let buf = "";
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let firstByteAt = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstByteAt) firstByteAt = Date.now();
      res.write(Buffer.from(value));
      if (buf.length < 262144) buf += dec.decode(value, { stream: true });
    }
  } catch (e) {
    row.error_class = "stream_interrupted";
  }
  res.end();

  // Surface upstream errors — otherwise a forwarded 4xx/5xx is a black box.
  if (!upstream.ok) {
    console.warn(
      `yardmaster-router: ${row.model} via ${hop.provider} -> HTTP ${upstream.status}` +
        (retries ? ` (after ${retries} retries)` : "") +
        `: ${buf.replace(/\s+/g, " ").slice(0, 400)}`,
    );
  }

  // usage: non-stream body has {usage}, a stream may carry a usage chunk.
  const usage = sniffUsage(buf);
  row.prompt_tokens = usage.prompt_tokens;
  row.completion_tokens = usage.completion_tokens;
  row.cached_tokens = usage.cached_tokens;
  row.estimated_cost_usd = usage.cost || 0;
  row.time_to_first_token_ms = firstByteAt ? firstByteAt - started : null;
  row.total_latency_ms = Date.now() - started;
  if (!upstream.ok && !row.error_class) row.error_class = "upstream_error";
  metrics.record(row);
}

// --- Ollama translation ------------------------------------------------
async function handleOllamaChat(req, res) {
  const raw = await readBody(req);
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: "invalid JSON body" });
  }
  const openai = {
    model: o.model,
    messages: o.messages || [],
    stream: o.stream !== false,
    ...(o.options?.temperature != null ? { temperature: o.options.temperature } : {}),
    ...(o.options?.num_predict != null ? { max_tokens: o.options.num_predict } : {}),
  };
  // Reuse the OpenAI path by faking a sub-request: resolve + dispatch, then
  // translate the response shape back to Ollama.
  const decided = resolveRoute(config, openai.model);
  if (!decided.ok) return json(res, 502, { error: `yardmaster-router: ${decided.error}` });
  const result = await dispatch(decided.chain, openai, {});
  if (result.error || !result.upstream) {
    return json(res, 502, { error: `yardmaster-router: all upstreams failed — ${result.error}` });
  }
  const { upstream, hop } = result;
  if (!upstream.ok) {
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(await upstream.text());
    return;
  }
  if (!openai.stream) {
    const j = await upstream.json();
    const msg = j.choices?.[0]?.message || { role: "assistant", content: "" };
    return json(res, 200, {
      model: hop.model,
      created_at: new Date().toISOString(),
      message: { role: msg.role || "assistant", content: msg.content || "" },
      done: true,
      done_reason: j.choices?.[0]?.finish_reason || "stop",
      prompt_eval_count: j.usage?.prompt_tokens || 0,
      eval_count: j.usage?.completion_tokens || 0,
    });
  }
  // stream: OpenAI SSE -> Ollama NDJSON
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let sseBuf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = sseBuf.indexOf("\n")) >= 0) {
      const line = sseBuf.slice(0, idx).trim();
      sseBuf = sseBuf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        res.write(JSON.stringify({ model: hop.model, created_at: new Date().toISOString(), message: { role: "assistant", content: "" }, done: true }) + "\n");
        continue;
      }
      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta?.content || "";
        if (delta) {
          res.write(JSON.stringify({ model: hop.model, created_at: new Date().toISOString(), message: { role: "assistant", content: delta }, done: false }) + "\n");
        }
      } catch {
        /* ignore partials */
      }
    }
  }
  res.end();
}

// --- server -----------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://router");
    const p = url.pathname;
    if (p === "/healthz") {
      return json(res, 200, {
        ok: true,
        mode: "router",
        config: loadedFrom,
        config_ok: config.ok,
        errors: config.errors,
        targets: Object.keys(config.targets).length,
      });
    }
    if (p === "/v1/capabilities" && req.method === "GET") {
      return json(res, 200, {
        records: [...registry.records.values()],
        applied: registry.plan.appliedEntries,
        applied_default: registry.plan.appliedDefaultId,
        desired_default: registry.desired?.defaultId ?? null,
        pending_ops: registry.plan.pendingOps,
        last_reconcile_ms: registry.lastReconcileMs,
        last_error: registry.lastError,
      });
    }
    if (p === "/v1/capabilities/reconcile" && req.method === "POST") {
      await reconcileNow();
      return json(res, 200, { pending_ops: registry.plan.pendingOps, applied: registry.plan.appliedEntries.length });
    }
    if (p === "/v1/capabilities/apply" && req.method === "POST") {
      const result = await forceApplyPending();
      return json(res, result.applied || result.unchanged ? 200 : 502, result);
    }
    if (p === "/v1/models" && req.method === "GET") {
      return json(res, 200, {
        object: "list",
        data: knownModels(config).map((id) => ({ id, object: "model", owned_by: "yardmaster" })),
      });
    }
    if (p === "/api/tags" && req.method === "GET") {
      return json(res, 200, {
        models: knownModels(config).map((name) => ({ name, model: name, size: 0, digest: "", details: {} })),
      });
    }
    if (p === "/v1/chat/completions" && req.method === "POST") {
      return handleChat(req, res, { ingress: "openai_chat" });
    }
    if (p === "/api/chat" && req.method === "POST") {
      return handleOllamaChat(req, res);
    }
    return json(res, 404, { error: { message: `yardmaster-router: no route for ${req.method} ${p}` } });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: { message: String(e.message || e) } });
    else res.end();
  }
});

server.listen(cfg.port, cfg.bind, () => {
  console.log(
    `yardmaster-router on http://${cfg.bind}:${cfg.port} (config: ${loadedFrom || "none yet"}, metrics: ${cfg.metricsDb})`,
  );
});

process.on("SIGTERM", () => {
  metrics.close();
  server.close(() => process.exit(0));
});
