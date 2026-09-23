// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * The capability-registry pipeline (ADR-0028, Phase 1). Replaces the shell
 * discovery in `harness-entrypoint.sh`: instead of the entrypoint curling
 * `/v1/models` once at boot and regenerating the whole `cordis.patch.yml`,
 * the router continuously derives a `Capability` registry from
 * `yardmaster.toml` + live provider probes + `[harness.overrides]` /
 * `[harness.policy]`, and renders it into a *delimited region* of
 * `cordis.patch.yml` that it owns exclusively — everything else in that file,
 * including a hand-written `cordis.user.yml` append, is untouched.
 *
 * Pipeline: discover -> normalize+probe -> policy -> approval (P4, opt-in
 * curation gate) -> select(default) -> render -> plan (additive-only apply,
 * destructive ops held) -> write (gated by `dsh --dump-config`, self-heals
 * from a `.lkg` snapshot on failure).
 *
 * Every stage up to `planApply` is pure and unit-tested without touching a
 * filesystem or network; `probeCapabilitySources` and `writeManagedRegion` are
 * the only I/O.
 */

import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { providerEndpoint } from "./router.mjs";

export const REGION_BEGIN = "# BEGIN yardmaster-managed  (do not edit; managed by the capability pipeline — ADR-0028)";
export const REGION_END = "# END yardmaster-managed";

// The pre-ADR-0028 harness-entrypoint.sh regenerated the whole models block
// behind this marker every boot (no END marker of its own — the file *was*
// the fossil). A deployment upgraded straight from that era still has this
// sitting ahead of wherever the new region belongs; keep the exact string in
// sync with the historical `MARKER` harness-entrypoint.sh used to write.
const LEGACY_ENTRYPOINT_MARKER = "# managed by yardmaster-harness-entrypoint";
// harness-entrypoint.sh's own USER_MARK — kept in sync by hand, same as above.
const USER_OVERLAY_MARK = "# --- appended from cordis.user.yml (user-owned) ---";

/**
 * Strip a pre-ADR-0028 fossil block, if one is sitting in `text`. It predates
 * entry-level ownership entirely — the whole file *was* generated output back
 * then — so like dsh's bare `[]` scaffold it is pipeline-owned and safe to
 * discard outright, never real user content. Bounded by whichever known
 * marker comes first after it (a cordis.user.yml append, this module's own
 * region) or end of file, since the legacy format had no closing marker.
 */
function stripLegacyFossil(text) {
  const li = text.indexOf(LEGACY_ENTRYPOINT_MARKER);
  if (li === -1) return text;
  const boundaries = [text.indexOf(USER_OVERLAY_MARK, li), text.indexOf(REGION_BEGIN, li)].filter((i) => i !== -1);
  const end = boundaries.length ? Math.min(...boundaries) : text.length;
  return text.slice(0, li) + text.slice(end);
}

// ---------------------------------------------------------------------------
// Config surface: [harness], [harness.policy], [harness.overrides.<id>]
// ---------------------------------------------------------------------------

/** `config` is the object `router.mjs#parseConfig` returns (has `.harness`). */
export function parseHarnessConfig(config) {
  const h = config.harness || {};
  const overrides = {};
  for (const [id, ov] of Object.entries(h.overrides || {})) {
    if (ov && typeof ov === "object") overrides[id] = ov;
  }
  const policy = h.policy && typeof h.policy === "object" ? h.policy : {};
  return {
    defaultModel: typeof h.default_model === "string" && h.default_model ? h.default_model : null,
    overrides,
    policy,
  };
}

function globToRegExp(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

// ---------------------------------------------------------------------------
// Stage 1 — discover: every declared target is a candidate Capability.
// ---------------------------------------------------------------------------

export function discover(config) {
  const records = new Map(); // id -> Capability
  let order = 0;
  for (const [targetName, t] of Object.entries(config.targets)) {
    if (!t || typeof t.id !== "string" || !t.id) continue;
    records.set(t.id, {
      id: t.id,
      target: targetName,
      provider: t.provider,
      locality: t.locality || "cluster",
      source: "declared",
      order: order++,
      context_window: Number.isFinite(t.context_window) ? t.context_window : null,
      capabilities: {
        tools: typeof t.tool_calling === "boolean" ? t.tool_calling : null,
        vision: typeof t.vision === "boolean" ? t.vision : null,
        reasoning: typeof t.reasoning === "boolean" ? t.reasoning : null,
      },
      pricing_usd_per_mtok: null,
      family: null,
      reachability: "discovered",
      reachability_checked_ms: null,
      // Set only by the opt-in smoke test (stage 3b, off by default — see
      // smokeTestCapabilities): a real chat-completions POST, not just a
      // model-list probe. smoke_test_checked_ms gates the retry interval
      // (an attempt, success or failure); smoke_test_error is the last
      // failure reason, cleared on the next success.
      smoke_test_checked_ms: null,
      smoke_test_error: null,
      policy: "enabled",
      policy_reason: null,
      // Fourth orthogonal axis (P4): "not_required" | "pending" | "approved" |
      // "rejected" — set by applyApproval() once [harness.overrides] is known.
      // Left "not_required" here so a record inspected before that stage
      // still has the field (discover() has no access to harnessCfg).
      approval: "not_required",
      rank: null,
      default: false,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Stage 2/3 — normalize + validate: merge probe metadata, set reachability.
// probeMap: Map<providerName, { ok, checkedMs, models: Map<id, {context_length, pricing}> } | null>
// ---------------------------------------------------------------------------

export function applyProbeResults(records, probeMap) {
  for (const rec of records.values()) {
    const p = probeMap.get(rec.provider);
    if (!p) continue; // provider not probed this round — leave "discovered"
    rec.reachability_checked_ms = p.checkedMs;
    if (!p.ok) {
      rec.reachability = "unreachable";
      continue;
    }
    const meta = p.models.get(rec.id);
    if (!meta) {
      rec.reachability = "unreachable";
      continue;
    }
    rec.reachability = "validated";
    if (rec.context_window == null && Number.isFinite(meta.context_length)) rec.context_window = meta.context_length;
    if (!rec.pricing_usd_per_mtok && meta.pricing) rec.pricing_usd_per_mtok = meta.pricing;
  }
  // Probed-but-undeclared models: visible in the registry (source "probed"),
  // never routable (no target), so always policy-disabled.
  for (const [providerName, p] of probeMap) {
    if (!p || !p.ok) continue;
    for (const [id, meta] of p.models) {
      if (records.has(id)) continue;
      records.set(id, {
        id,
        target: null,
        provider: providerName,
        locality: null,
        source: "probed",
        order: 1_000_000 + records.size,
        context_window: Number.isFinite(meta.context_length) ? meta.context_length : null,
        capabilities: { tools: null, vision: null, reasoning: null },
        pricing_usd_per_mtok: meta.pricing || null,
        family: null,
        reachability: "validated",
        reachability_checked_ms: p.checkedMs,
        smoke_test_checked_ms: null,
        smoke_test_error: null,
        policy: "disabled",
        policy_reason: "not declared as a target",
        // Never routable (no target) — approval is moot; applyApproval()
        // leaves it "not_required" too, this just avoids a null in the
        // window before that stage runs.
        approval: "not_required",
        rank: null,
        default: false,
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Stage 4 — policy: [harness.policy] rules, then [harness.overrides] (wins).
// ---------------------------------------------------------------------------

export function applyPolicy(records, harnessCfg) {
  const policy = harnessCfg.policy || {};
  const denyGlobs = (Array.isArray(policy.deny_glob) ? policy.deny_glob : []).map(globToRegExp);
  const minCtx = Number.isFinite(policy.min_context_window) ? policy.min_context_window : null;
  const rankByLocality =
    policy.rank_by_locality && typeof policy.rank_by_locality === "object"
      ? policy.rank_by_locality
      : { cluster: 0, lan: 10, remote: 20 };

  for (const rec of records.values()) {
    if (!rec.target) {
      // probed-only: already disabled in applyProbeResults; still needs a rank
      // so it sorts sensibly if an override later makes it targetable.
      rec.rank = (rankByLocality[rec.locality] ?? 100) * 1000 + rec.order;
      continue;
    }
    rec.policy = "enabled";
    rec.policy_reason = null;
    if (denyGlobs.some((re) => re.test(rec.id))) {
      rec.policy = "disabled";
      rec.policy_reason = "policy: deny_glob";
    } else if (minCtx != null && Number.isFinite(rec.context_window) && rec.context_window < minCtx) {
      rec.policy = "disabled";
      rec.policy_reason = "policy: min_context_window";
    }
    rec.rank = (rankByLocality[rec.locality] ?? 100) * 1000 + rec.order;
  }

  for (const [id, ov] of Object.entries(harnessCfg.overrides)) {
    const rec = records.get(id);
    if (!rec) continue; // override for an id we don't know about yet — no-op
    if (typeof ov.enabled === "boolean") {
      rec.policy = ov.enabled ? "enabled" : "disabled";
      rec.policy_reason = "operator override";
    }
    if (Number.isFinite(ov.rank)) rec.rank = ov.rank;
    if (Number.isFinite(ov.context_window)) rec.context_window = ov.context_window;
    if (ov.capabilities && typeof ov.capabilities === "object") {
      rec.capabilities = { ...rec.capabilities, ...ov.capabilities };
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Stage 4b — approval (P4): a curation gate independent of `policy`. Opt-in
// ([harness.policy] require_approval = true, default false — preserves the
// original auto-apply-additive behavior). When on, every routable id needs
// an explicit `[harness.overrides.<id>].approved` (true or false) before it
// can ever be rendered to dsh or chosen as default; the Console's Capabilities
// tab writes that key via the same override-upsert path Enable/Disable and
// Set default already use. An id an operator has never opined on sits
// "pending" — visible in the registry, excluded from the render — until
// approved or rejected. Once set, the override persists the decision across
// reconciles (discover() rebuilds fresh records every cycle; the override is
// what remembers).
// ---------------------------------------------------------------------------

export function applyApproval(records, harnessCfg) {
  const requireApproval = harnessCfg.policy?.require_approval === true;
  for (const rec of records.values()) {
    if (!rec.target) {
      rec.approval = "not_required"; // probed-only: never routable, approval is moot
      continue;
    }
    const ov = harnessCfg.overrides[rec.id];
    if (ov && typeof ov.approved === "boolean") {
      rec.approval = ov.approved ? "approved" : "rejected";
      continue;
    }
    rec.approval = requireApproval ? "pending" : "not_required";
  }
  return records;
}

/** True unless a curation decision (or its absence) blocks this id from being
 * rendered/selected — i.e. everything except "pending" and "rejected". */
function approvalOk(rec) {
  return rec.approval !== "pending" && rec.approval !== "rejected";
}

// ---------------------------------------------------------------------------
// Stage 5 — select: exactly one default. `source` tells the apply stage
// whether this was an explicit operator choice (auto-applies) or the
// pipeline's own fallback guess (held for approval if it changes).
// ---------------------------------------------------------------------------

export function selectDefault(records, config, harnessCfg) {
  for (const rec of records.values()) rec.default = false;
  const routable = (r) => r.target && r.policy === "enabled" && approvalOk(r);
  const enabledRoutable = () => [...records.values()].filter(routable);

  const overrideDefault = Object.entries(harnessCfg.overrides).find(([, ov]) => ov && ov.default === true);
  if (overrideDefault) {
    const rec = records.get(overrideDefault[0]);
    if (rec && routable(rec)) {
      rec.default = true;
      return { id: rec.id, source: "override" };
    }
  }
  if (harnessCfg.defaultModel) {
    const rec = records.get(harnessCfg.defaultModel);
    if (rec && routable(rec)) {
      rec.default = true;
      return { id: rec.id, source: "harness.default_model" };
    }
  }
  const dr = config.routes?.default;
  if (dr && dr.target && config.targets[dr.target]) {
    const id = config.targets[dr.target].id;
    const rec = records.get(id);
    if (rec && routable(rec)) {
      rec.default = true;
      return { id: rec.id, source: "routes.default" };
    }
  }
  const candidates = enabledRoutable().sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const local = candidates.filter((r) => r.locality !== "remote");
  if (local.length) {
    local[0].default = true;
    return { id: local[0].id, source: "best-local" };
  }
  if (candidates.length) {
    candidates[0].default = true;
    return { id: candidates[0].id, source: "best-any" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 6 — render: the "desired" list dsh should see, if nothing were held.
// ---------------------------------------------------------------------------

export function desiredEntries(records) {
  return [...records.values()]
    .filter(
      (r) =>
        r.target &&
        r.policy === "enabled" &&
        approvalOk(r) &&
        (r.reachability === "validated" || r.reachability === "smoke_tested"),
    )
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .map((r) => ({ id: r.id, contextWindow: Number.isFinite(r.context_window) ? r.context_window : undefined }));
}

function yamlDq(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function unYamlDq(s) {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Deterministic dsh fragment for the given (already-decided) entry list. */
export function renderRegion(entries, defaultId, upstream) {
  const lines = [REGION_BEGIN];
  lines.push("- id: llm-pi-ai");
  lines.push("  config:");
  lines.push("    providers:");
  lines.push("      yardmaster:");
  lines.push("        displayName: Yardmaster");
  lines.push(`        baseURL: ${yamlDq(upstream)}`);
  lines.push("        api: openai-completions");
  lines.push("        models:");
  for (const e of entries) {
    lines.push(`          - id: ${yamlDq(e.id)}`);
    if (Number.isFinite(e.contextWindow)) lines.push(`            contextWindow: ${e.contextWindow}`);
  }
  lines.push("- id: agent-default-model");
  lines.push("  config:");
  lines.push("    provider: yardmaster");
  lines.push(`    model: ${yamlDq(defaultId ?? "")}`);
  lines.push(REGION_END);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Region (de)serialization — read/replace only the bytes between the markers.
// ---------------------------------------------------------------------------

export function splitRegion(text) {
  const bi = text.indexOf(REGION_BEGIN);
  const ei = text.indexOf(REGION_END);
  if (bi === -1 || ei === -1 || ei < bi) return null;
  return { before: text.slice(0, bi), region: text.slice(bi, ei + REGION_END.length), after: text.slice(ei + REGION_END.length) };
}

/** Parse a region *this module previously rendered* back into entries + default. */
export function parseAppliedRegion(text) {
  const split = splitRegion(text);
  if (!split) return null;
  const entries = [];
  let defaultId = null;
  let inModels = false;
  for (const raw of split.region.split("\n")) {
    if (/^\s*models:\s*$/.test(raw)) {
      inModels = true;
      continue;
    }
    if (/^-\s*id:\s*agent-default-model\s*$/.test(raw)) {
      inModels = false;
      continue;
    }
    if (inModels) {
      const m = /^\s*-\s*id:\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(raw);
      if (m) {
        entries.push({ id: unYamlDq(m[1]), contextWindow: undefined });
        continue;
      }
      const c = /^\s*contextWindow:\s*(\d+)\s*$/.exec(raw);
      if (c && entries.length) entries[entries.length - 1].contextWindow = Number(c[1]);
    }
    const dm = /^\s*model:\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(raw);
    if (dm) defaultId = unYamlDq(dm[1]);
  }
  return { entries, defaultId };
}

// ---------------------------------------------------------------------------
// Stage 7/8 — plan: additive changes always apply; destructive ones (a model
// disappearing because the world changed, or the default changing because the
// pipeline's own fallback guess moved) are held pending approval. A change the
// operator explicitly asked for (an override, [harness.default_model], or
// [routes.default].target) is its own approval and applies immediately.
// ---------------------------------------------------------------------------

export function planApply(previousApplied, desired) {
  const prevEntries = previousApplied?.entries || [];
  const prevIds = new Set(prevEntries.map((e) => e.id));
  const desiredIds = new Set(desired.entries.map((e) => e.id));
  const pendingOps = [];
  const appliedByid = new Map(prevEntries.map((e) => [e.id, e]));

  // Adds + metadata refresh: always additive.
  for (const e of desired.entries) appliedByid.set(e.id, e);

  // Removals: auto-apply only when the record's disablement came from an
  // explicit operator override; everything else (a policy rule, or the model
  // going unreachable) is held so dsh keeps offering it until approved.
  for (const id of prevIds) {
    if (desiredIds.has(id)) continue;
    const rec = desired.recordsById.get(id);
    const overrideDriven = rec?.policy === "disabled" && rec.policy_reason === "operator override";
    if (overrideDriven) {
      appliedByid.delete(id);
    } else {
      pendingOps.push({ type: "remove", id, reason: rec?.policy_reason || "no longer discovered or validated" });
    }
  }

  let appliedDefaultId = previousApplied?.defaultId ?? desired.defaultId;
  if (desired.defaultId && desired.defaultId !== appliedDefaultId) {
    const explicit = desired.defaultSource === "override" || desired.defaultSource === "harness.default_model" || desired.defaultSource === "routes.default";
    const noUsableCurrentDefault = !appliedDefaultId || !appliedByid.has(appliedDefaultId);
    if (explicit || noUsableCurrentDefault) {
      appliedDefaultId = desired.defaultId;
    } else {
      pendingOps.push({ type: "default-change", from: appliedDefaultId, to: desired.defaultId, reason: desired.defaultSource });
    }
  }
  if (!appliedDefaultId || !appliedByid.has(appliedDefaultId)) appliedDefaultId = desired.defaultId;

  const appliedEntries = [...appliedByid.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { appliedEntries, appliedDefaultId, pendingOps };
}

// ---------------------------------------------------------------------------
// I/O — probing and the gated, self-healing file write.
// ---------------------------------------------------------------------------

/** Probe every provider referenced by a declared target for its live model list. */
export async function probeCapabilitySources(config, { timeoutMs = 4000 } = {}) {
  const providerNames = new Set();
  for (const t of Object.values(config.targets)) if (t?.provider) providerNames.add(t.provider);

  const results = new Map();
  await Promise.all(
    [...providerNames].map(async (name) => {
      const checkedMs = Date.now();
      const ep = providerEndpoint(name, config.providers);
      if (ep.error) {
        results.set(name, { ok: false, checkedMs, models: new Map() });
        return;
      }
      const base = ep.baseUrl.replace(/\/+$/, "");
      const url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const headers = { accept: "application/json" };
        if (ep.apiKey) headers.authorization = `Bearer ${ep.apiKey}`;
        const r = await fetch(url, { signal: ac.signal, headers });
        clearTimeout(timer);
        if (!r.ok) {
          results.set(name, { ok: false, checkedMs, models: new Map() });
          return;
        }
        const j = await r.json();
        const models = new Map();
        for (const m of j.data || []) {
          if (!m?.id) continue;
          const promptPrice = Number(m.pricing?.prompt);
          const completionPrice = Number(m.pricing?.completion);
          models.set(m.id, {
            context_length: Number.isFinite(m.context_length) ? m.context_length : null,
            pricing:
              Number.isFinite(promptPrice) || Number.isFinite(completionPrice)
                ? { in: Number.isFinite(promptPrice) ? promptPrice * 1e6 : null, out: Number.isFinite(completionPrice) ? completionPrice * 1e6 : null }
                : null,
          });
        }
        results.set(name, { ok: true, checkedMs, models });
      } catch {
        clearTimeout(timer);
        results.set(name, { ok: false, checkedMs, models: new Map() });
      }
    }),
  );
  return results;
}

/** One minimal chat-completions POST — the actual real-money request a smoke
 * test makes. `max_tokens: 1` keeps the cost negligible on paid providers. */
async function smokeTestOne(providerEp, modelId, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (providerEp.apiKey) headers.authorization = `Bearer ${providerEp.apiKey}`;
    const body = JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false });
    const r = await fetch(providerEp.chatUrl, { method: "POST", headers, body, signal: ac.signal });
    clearTimeout(timer);
    if (r.ok) return { ok: true };
    const text = await r.text().catch(() => "");
    return { ok: false, error: `HTTP ${r.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}` };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(e.message || e) };
  }
}

/**
 * Opt-in smoke test (ADR-0028 P3): upgrades `reachability` from "validated"
 * (the id appeared in the provider's `/v1/models` list) to "smoke_tested" (a
 * real chat-completions request against that id actually succeeded) —
 * strictly additive confidence, never a gate on what's applied to dsh
 * (`desiredEntries` already accepts either). **Off by default**
 * (`[harness.policy] smoke_test = true` to enable) because it spends real
 * money on paid providers; rate-limited by `smoke_test_interval_s` (default
 * 1h) so it doesn't fire on every reconcile.
 *
 * `state` is a `Map<id, {lastAttemptMs: number|null, lastSuccessMs, lastError}>`
 * (`lastAttemptMs: null` means "never attempted" — always due) the
 * caller owns and passes back in on every call — this is the one stage in
 * the pipeline with cross-reconcile memory, since `discover()` rebuilds
 * fresh records every cycle and has no other way to know "already tested
 * recently" without re-spending on every single reconcile.
 */
export async function smokeTestCapabilities(records, config, harnessCfg, { timeoutMs = 8000, now = Date.now(), state } = {}) {
  const policy = harnessCfg.policy || {};
  if (policy.smoke_test !== true) return records;
  const intervalMs = Number.isFinite(policy.smoke_test_interval_s) ? policy.smoke_test_interval_s * 1000 : 3_600_000;
  const eligible = (r) =>
    r.target && r.policy === "enabled" && approvalOk(r) && (r.reachability === "validated" || r.reachability === "smoke_tested");

  const jobs = [];
  for (const rec of records.values()) {
    if (!eligible(rec)) continue;
    const st = state.get(rec.id) ?? { lastAttemptMs: null, lastSuccessMs: null, lastError: null };
    state.set(rec.id, st);
    // Never attempted -> always due, regardless of `now`'s magnitude (don't
    // rely on `now` already being larger than one interval, even though a
    // real Date.now() always is).
    if (st.lastAttemptMs != null && now - st.lastAttemptMs < intervalMs) continue; // not due yet — reuse remembered state below
    const ep = providerEndpoint(rec.provider, config.providers);
    if (ep.error) {
      st.lastAttemptMs = now;
      st.lastError = ep.error;
      continue;
    }
    jobs.push(
      smokeTestOne(ep, rec.id, timeoutMs).then((res) => {
        st.lastAttemptMs = now;
        if (res.ok) {
          st.lastSuccessMs = now;
          st.lastError = null;
        } else {
          st.lastError = res.error;
        }
      }),
    );
  }
  await Promise.all(jobs);

  for (const rec of records.values()) {
    if (!eligible(rec)) continue;
    const st = state.get(rec.id);
    if (!st) continue;
    rec.smoke_test_checked_ms = st.lastAttemptMs ?? null;
    if (st.lastError === null && st.lastSuccessMs != null) {
      rec.reachability = "smoke_tested";
      rec.smoke_test_error = null;
    } else {
      rec.smoke_test_error = st.lastError;
    }
  }
  return records;
}

/**
 * Write the managed region into `patchPath`, gated by `validate()`. On a
 * validation failure the file is restored from `patchPath + ".lkg"` (the
 * snapshot taken just before this write) so a bad render can never leave dsh
 * crash-looping — the same synchronous gate that caught every schema mistake
 * made by hand in this repo's own testing.
 */
export async function writeManagedRegion({ patchPath, entries, defaultId, upstream, validate }) {
  const regionText = renderRegion(entries, defaultId, upstream);
  let rawExisting = "";
  try {
    rawExisting = await readFile(patchPath, "utf8");
  } catch {
    /* first write ever */
  }
  const existing = stripLegacyFossil(rawExisting);
  const split = splitRegion(existing);
  let before;
  if (split) {
    before = split.before;
  } else {
    // No region yet. dsh's own scaffold boilerplate (a bare "[]", or comments
    // only — the "must be a top-level YAML array" crash we hit by hand is
    // exactly this) must never survive as a literal prefix: "[]" followed by
    // more block-sequence items is invalid YAML. Treat that residue as empty;
    // keep anything real (e.g. a user's own patch entries) as-is.
    const residue = existing.replace(/#.*$/gm, "").replace(/\s+/g, "");
    before = residue === "" || residue === "[]" ? "" : existing.endsWith("\n") ? existing : `${existing}\n`;
  }
  // `regionText` already ends in exactly one newline; strip any leading blank
  // lines `after` re-supplies on a round-trip so repeated writes of the same
  // entries are byte-identical (and correctly detected as "unchanged" below)
  // instead of growing a blank line on every reconcile.
  const after = split ? split.after.replace(/^\n+/, "") : "";
  const newText = before + regionText + after;

  // Compare against the *raw* on-disk bytes, not the fossil-stripped view:
  // a write that only removes a legacy fossil (no other diff) must still
  // land on disk, or the "unchanged" fast path silently leaves it in place.
  if (newText === rawExisting) return { applied: false, unchanged: true };

  const lkgPath = `${patchPath}.lkg`;
  try {
    await copyFile(patchPath, lkgPath);
  } catch {
    /* nothing to snapshot yet */
  }

  // The Harness container scaffolds `profiles/web/` on its own first boot;
  // the router may reconcile before that's happened (no ordering guarantee
  // beyond "the volume is mounted"), so don't depend on boot order.
  await mkdir(dirname(patchPath), { recursive: true });
  await writeFile(patchPath, newText, "utf8");

  if (validate) {
    const result = await validate();
    if (!result.ok) {
      const restored = await rollbackToLastKnownGood(patchPath);
      return { applied: false, error: result.error, rolledBack: restored };
    }
  }
  return { applied: true };
}

export async function rollbackToLastKnownGood(patchPath) {
  try {
    await copyFile(`${patchPath}.lkg`, patchPath);
    return true;
  } catch {
    return false;
  }
}

/** `dsh --profile web --dump-config` against DSH_HOME — the same static gate
 * that has caught every malformed cordis.patch.yml in this repo's history. */
export function makeDshValidator({ dshBin, dshHome, nodeBin = process.execPath, timeoutMs = 20000 }) {
  return () =>
    new Promise((resolve) => {
      if (!dshBin) return resolve({ ok: true }); // no dsh available (e.g. tests) — skip the gate
      execFile(
        nodeBin,
        [dshBin, "--profile", "web", "--dump-config"],
        { env: { ...process.env, DSH_HOME: dshHome }, timeout: timeoutMs },
        (err, _stdout, stderr) => {
          resolve(err ? { ok: false, error: String(stderr || err.message).trim().slice(0, 4000) } : { ok: true });
        },
      );
    });
}

// ---------------------------------------------------------------------------
// The full pure pipeline, stages 1-7 (no I/O — probeMap and previousApplied
// are supplied by the caller, which owns the I/O).
// ---------------------------------------------------------------------------

export function runPipeline(config, probeMap, harnessCfg, previousApplied) {
  let records = discover(config);
  records = applyProbeResults(records, probeMap);
  records = applyPolicy(records, harnessCfg);
  records = applyApproval(records, harnessCfg);
  const defaultChoice = selectDefault(records, config, harnessCfg);
  const desired = {
    entries: desiredEntries(records),
    defaultId: defaultChoice?.id ?? null,
    defaultSource: defaultChoice?.source ?? null,
    recordsById: records,
  };
  const plan = planApply(previousApplied, desired);
  return { records, desired, plan };
}
