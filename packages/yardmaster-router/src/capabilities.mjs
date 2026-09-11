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
 * Pipeline: discover -> normalize+probe -> policy -> select(default) ->
 * render -> plan (additive-only apply, destructive ops held) -> write (gated
 * by `dsh --dump-config`, self-heals from a `.lkg` snapshot on failure).
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
      policy: "enabled",
      policy_reason: null,
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
        policy: "disabled",
        policy_reason: "not declared as a target",
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
// Stage 5 — select: exactly one default. `source` tells the apply stage
// whether this was an explicit operator choice (auto-applies) or the
// pipeline's own fallback guess (held for approval if it changes).
// ---------------------------------------------------------------------------

export function selectDefault(records, config, harnessCfg) {
  for (const rec of records.values()) rec.default = false;
  const enabledRoutable = () => [...records.values()].filter((r) => r.target && r.policy === "enabled");

  const overrideDefault = Object.entries(harnessCfg.overrides).find(([, ov]) => ov && ov.default === true);
  if (overrideDefault) {
    const rec = records.get(overrideDefault[0]);
    if (rec && rec.policy === "enabled") {
      rec.default = true;
      return { id: rec.id, source: "override" };
    }
  }
  if (harnessCfg.defaultModel) {
    const rec = records.get(harnessCfg.defaultModel);
    if (rec && rec.policy === "enabled") {
      rec.default = true;
      return { id: rec.id, source: "harness.default_model" };
    }
  }
  const dr = config.routes?.default;
  if (dr && dr.target && config.targets[dr.target]) {
    const id = config.targets[dr.target].id;
    const rec = records.get(id);
    if (rec && rec.policy === "enabled") {
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
    .filter((r) => r.target && r.policy === "enabled" && r.reachability === "validated")
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

/**
 * Write the managed region into `patchPath`, gated by `validate()`. On a
 * validation failure the file is restored from `patchPath + ".lkg"` (the
 * snapshot taken just before this write) so a bad render can never leave dsh
 * crash-looping — the same synchronous gate that caught every schema mistake
 * made by hand in this repo's own testing.
 */
export async function writeManagedRegion({ patchPath, entries, defaultId, upstream, validate }) {
  const regionText = renderRegion(entries, defaultId, upstream);
  let existing = "";
  try {
    existing = await readFile(patchPath, "utf8");
  } catch {
    /* first write ever */
  }
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

  if (newText === existing) return { applied: false, unchanged: true };

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
