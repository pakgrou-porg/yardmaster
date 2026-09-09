// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * Discover the inference backends a `yardmaster.toml` points at and probe each
 * for liveness + model inventory. This works today (it just does HTTP GETs);
 * it does not need the Rust data plane. It is how the console shows "Yardmaster
 * is watching these backends" before routing is wired.
 */

import { parse as parseToml } from "smol-toml";

const DEFAULT_TIMEOUT_MS = 2500;

// Keyed cloud providers have no `base_url` in the config (the endpoint is
// implicit). Probe them at their published API root, with the key from the env
// var named by `api_key_env`.
const KEYED_DEFAULT_BASE = {
  openrouter: "https://openrouter.ai/api/v1",
  venice: "https://api.venice.ai/api/v1",
  kie: "https://api.kie.ai/v1",
};

/** Candidate URLs to try for a model list, in order. First 200 wins. */
function modelListUrls(base) {
  const b = base.replace(/\/+$/, "");
  const noV1 = b.replace(/\/v1$/, "");
  return [`${b}/models`, `${noV1}/v1/models`, `${noV1}/api/tags`];
}

function extractModels(url, body) {
  try {
    const j = JSON.parse(body);
    if (Array.isArray(j.data)) return j.data.map((m) => m.id).filter(Boolean);
    if (Array.isArray(j.models)) return j.models.map((m) => m.name || m.id || m.model).filter(Boolean);
  } catch {
    /* fall through */
  }
  return [];
}

async function probeOne(name, kind, base, timeoutMs, apiKey) {
  const started = Date.now();
  const headers = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  for (const url of modelListUrls(base)) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ac.signal, headers });
      clearTimeout(t);
      if (r.status === 401 || r.status === 403) {
        clearTimeout(t);
        return {
          name, kind, base_url: base, probed: url, up: false,
          latency_ms: Date.now() - started, models: [],
          error: `${r.status} — check the API key`,
        };
      }
      if (r.ok) {
        const body = await r.text();
        return {
          name,
          kind,
          base_url: base,
          probed: url,
          up: true,
          latency_ms: Date.now() - started,
          models: extractModels(url, body),
          error: null,
        };
      }
    } catch (e) {
      clearTimeout(t);
      var lastErr = e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : e.message;
    }
  }
  return {
    name,
    kind,
    base_url: base,
    probed: null,
    up: false,
    latency_ms: Date.now() - started,
    models: [],
    error: lastErr || "no model-list endpoint responded",
  };
}

/**
 * Given the raw config text, return the de-duplicated backend list with each
 * one's probe result. `localEngineUrl` (from YM_LOCAL_ENGINE_URL) is probed too
 * so the single-box setup shows its engine even with no `[providers]`.
 */
export async function probeBackends(rawText, { localEngineUrl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let doc = {};
  try {
    doc = parseToml(rawText || "");
  } catch {
    /* an unparseable config still lets us probe the local engine */
  }

  // Dedup key ignores a trailing `/v1` so a provider `.../v1` and a bare local
  // engine URL for the same host:port collapse to one row.
  const dedupKey = (u) => u.replace(/\/+$/, "").replace(/\/v1$/, "");
  const seen = new Map(); // dedupKey -> { name, kind, base_url, apiKey }
  for (const [pname, p] of Object.entries(doc.providers ?? {})) {
    const kind = p.kind || "openai_compatible";
    let base = typeof p.base_url === "string" && p.base_url ? p.base_url.replace(/\/+$/, "") : "";
    let apiKey;
    if (!base && KEYED_DEFAULT_BASE[kind]) base = KEYED_DEFAULT_BASE[kind];
    if (typeof p.api_key_env === "string" && p.api_key_env) apiKey = process.env[p.api_key_env] || "";
    if (!base) continue; // nothing to probe (openai_compatible needs a base_url)
    if (KEYED_DEFAULT_BASE[kind] && apiKey === "") {
      seen.set(`${pname}:nokey`, { name: pname, kind, base_url: base, missingKey: p.api_key_env });
      continue;
    }
    seen.set(dedupKey(base) + ":" + pname, { name: pname, kind, base_url: base, apiKey });
  }
  if (localEngineUrl) {
    const base = localEngineUrl.replace(/\/+$/, "");
    const k = dedupKey(base);
    if (![...seen.values()].some((v) => dedupKey(v.base_url) === k)) {
      seen.set(k, { name: "local-engine", kind: "local", base_url: base });
    }
  }

  const results = await Promise.all(
    [...seen.values()].map(({ name, kind, base_url, apiKey, missingKey }) =>
      missingKey
        ? Promise.resolve({
            name, kind, base_url, probed: null, up: false, latency_ms: 0, models: [],
            error: `${missingKey} is not set in the environment`,
          })
        : probeOne(name, kind, base_url, timeoutMs, apiKey),
    ),
  );
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}
