// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * A `yardmaster.toml` validator that mirrors `switchyard-server --dry-run`
 * strictness (reject unknown keys) plus Yardmaster's superset rules, in
 * JavaScript, so the console can validate before the Rust data plane exists.
 * When `yardmaster-dataplane dry-run` is available the server prefers it and
 * this becomes a fast pre-check.
 *
 * Returns `{ ok, errors: string[], warnings: string[] }`.
 */

import { parse as parseToml } from "smol-toml";

const TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "fallback_client",
  "llm_clients",
  "targets",
  "routes",
  "cluster",
  "placement",
  "egress",
  "ingress",
  "providers",
  "discovery",
  "metrics",
  "tiers",
  "harness",
]);

const TARGET_KEYS = new Set([
  "id", "llm_client", "provider", "locality", "extra_body", "extra_headers",
  "context_window", "tool_calling", "reasoning", "vision",
]);
// [harness] — the DeepSeek Harness capability registry (ADR-0028).
const HARNESS_KEYS = new Set(["default_model", "policy", "overrides"]);
const HARNESS_POLICY_KEYS = new Set(["deny_glob", "min_context_window", "rank_by_locality"]);
const HARNESS_OVERRIDE_KEYS = new Set(["enabled", "rank", "context_window", "capabilities", "default"]);
const HARNESS_CAPABILITY_FLAGS = new Set(["tools", "vision", "reasoning"]);
const LOCALITIES_FOR_RANK = new Set(["cluster", "lan", "remote"]);
const PROVIDER_KEYS = new Set([
  "kind", "base_url", "api_key_env", "api_key_ref", "models_allow", "models_deny",
  "rate_limit_rpm", "budget_usd_per_day", "timeout_s", "pricing", "media",
]);
const PROVIDER_KINDS = new Set(["openrouter", "venice", "kie", "openai_compatible"]);
const KEYED_PROVIDER_KINDS = new Set(["openrouter", "venice", "kie"]);
const ROUTE_TYPES = new Set([
  "passthrough", "random", "stage_router", "llm_classifier", "escalation",
  "plan_execute", "noop", "composite", "prefill_router",
]);
const LOCALITIES = new Set(["cluster", "lan", "remote"]);
const EGRESS_KEYS = new Set(["allow_remote", "allow_lan"]);
const INGRESS_KEYS = new Set(["ollama_port", "openai_port", "anthropic_port", "max_body_bytes"]);
const PLACEMENT_POLICIES = new Set(["pair_default", "warm_first", "vram_aware"]);
const TIER_ROLES = new Set(["planner", "worker", "judge"]);

// Looks like a literal secret that must never be in the file.
const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|[A-Fa-f0-9]{40,}|xox[baprs]-[A-Za-z0-9-]{10,})/;

function isPrivateHost(host) {
  if (/^(localhost|127\.|::1|10\.|192\.168\.|169\.254\.|fc|fd)/i.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m) {
    const o = Number(m[1]);
    return o >= 16 && o <= 31;
  }
  return false;
}

export function validateConfig(rawText) {
  const errors = [];
  const warnings = [];
  let doc;
  try {
    doc = parseToml(rawText);
  } catch (e) {
    return { ok: false, errors: [`TOML parse error: ${e.message}`], warnings: [] };
  }

  if (SECRET_RE.test(rawText)) {
    errors.push(
      "the config appears to contain a literal API key/secret — keys go in an " +
        "environment variable (api_key_env) or the OS credential store (api_key_ref), never the TOML",
    );
  }

  for (const k of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(k)) errors.push(`unknown top-level key \`${k}\``);
  }

  if (doc.schema_version !== 1) {
    errors.push("`schema_version` must be present and equal to 1");
  }
  if (!("targets" in doc)) errors.push("missing `[targets]` table (may be empty, but must be present)");
  if (!("routes" in doc) && !("tiers" in doc)) {
    warnings.push("no `[routes]` and no `[tiers]` — only zero-config pass-through by model name will work");
  }

  const egress = doc.egress ?? {};
  for (const k of Object.keys(egress)) {
    if (!EGRESS_KEYS.has(k)) errors.push(`unknown key \`egress.${k}\``);
  }
  const allowRemote = egress.allow_remote === true;
  const allowLan = egress.allow_lan !== false; // default true

  // ---- providers ---------------------------------------------------------
  const providers = doc.providers ?? {};
  for (const [name, p] of Object.entries(providers)) {
    const at = `providers.${name}`;
    for (const k of Object.keys(p)) {
      if (!PROVIDER_KEYS.has(k)) errors.push(`unknown key \`${at}.${k}\``);
    }
    const kind = p.kind;
    if (kind === undefined) {
      warnings.push(`\`${at}\` has no \`kind\` — assuming "openai_compatible"`);
    } else if (!PROVIDER_KINDS.has(kind)) {
      errors.push(`\`${at}.kind\` must be one of ${[...PROVIDER_KINDS].join(", ")}`);
    }
    const effectiveKind = PROVIDER_KINDS.has(kind) ? kind : "openai_compatible";
    const hasEnv = typeof p.api_key_env === "string" && p.api_key_env.length > 0;
    const hasRef = typeof p.api_key_ref === "string" && p.api_key_ref.length > 0;
    if (KEYED_PROVIDER_KINDS.has(effectiveKind)) {
      if (hasEnv === hasRef) {
        errors.push(`\`${at}\`: exactly one of api_key_env or api_key_ref is required for ${effectiveKind}`);
      }
    }
    if (typeof p.base_url === "string" && p.base_url.length) {
      let u;
      try {
        u = new URL(p.base_url);
      } catch {
        errors.push(`\`${at}.base_url\` is not a valid URL`);
      }
      if (u) {
        if (KEYED_PROVIDER_KINDS.has(effectiveKind) && u.protocol !== "https:") {
          errors.push(`\`${at}.base_url\` must be https for ${effectiveKind}`);
        }
        if (effectiveKind === "openai_compatible" && u.protocol === "http:" && !isPrivateHost(u.hostname)) {
          errors.push(`\`${at}.base_url\`: plain http is only allowed for openai_compatible on a private-range address`);
        }
      }
    } else if (effectiveKind !== "openrouter" && effectiveKind !== "venice" && effectiveKind !== "kie") {
      // openai_compatible with no base_url is meaningless
      errors.push(`\`${at}.base_url\` is required for openai_compatible`);
    }
  }

  // ---- targets ----------------------------------------------------------
  const targets = doc.targets ?? {};
  const targetLocality = {};
  for (const [name, t] of Object.entries(targets)) {
    if (t === null || typeof t !== "object") continue; // `[targets]` header only
    const at = `targets.${name}`;
    for (const k of Object.keys(t)) {
      if (!TARGET_KEYS.has(k)) errors.push(`unknown key \`${at}.${k}\``);
    }
    if (typeof t.id !== "string" || !t.id) errors.push(`\`${at}.id\` is required`);
    const loc = t.locality ?? "cluster";
    targetLocality[name] = loc;
    if (!LOCALITIES.has(loc)) errors.push(`\`${at}.locality\` must be cluster | lan | remote`);
    if (loc === "remote" && !allowRemote) {
      errors.push(`\`${at}\` is locality = "remote" but [egress] allow_remote is not true`);
    }
    if (loc === "lan" && !allowLan) {
      warnings.push(`\`${at}\` is locality = "lan" but [egress] allow_lan = false — it will be unusable`);
    }
    if (t.provider !== undefined && !(t.provider in providers)) {
      errors.push(`\`${at}.provider\` = "${t.provider}" has no matching [providers.${t.provider}]`);
    }
  }

  // ---- routes ---------------------------------------------------------
  const routes = doc.routes ?? {};
  for (const [name, r] of Object.entries(routes)) {
    if (r === null || typeof r !== "object") continue;
    const at = `routes.${name}`;
    if (typeof r.id !== "string" || !r.id) errors.push(`\`${at}.id\` is required`);
    if (!ROUTE_TYPES.has(r.type)) errors.push(`\`${at}.type\` must be one of ${[...ROUTE_TYPES].join(", ")}`);
    if (r.judge_egress !== undefined && !["deny", "allow"].includes(r.judge_egress)) {
      errors.push(`\`${at}.judge_egress\` must be "deny" or "allow"`);
    }
    const refs = [r.target, r.weak_target, r.strong_target, r.capable_target, r.efficient_target, r.classifier_target]
      .filter((x) => typeof x === "string");
    for (const ref of refs) {
      if (!(ref in targets)) {
        errors.push(`\`${at}\` references target "${ref}" which is not defined`);
      } else if (targetLocality[ref] === "remote" && !allowRemote) {
        errors.push(`\`${at}\` selects remote target "${ref}" while [egress] allow_remote is not true`);
      }
    }
    if (r.type === "passthrough" && typeof r.target !== "string") {
      errors.push(`\`${at}\`: passthrough requires \`target\``);
    }
  }

  // ---- tiers --------------------------------------------------------
  for (const [name, t] of Object.entries(doc.tiers ?? {})) {
    const at = `tiers.${name}`;
    if (!TIER_ROLES.has(t.role)) errors.push(`\`${at}.role\` must be planner | worker | judge`);
    if (!Array.isArray(t.models) || t.models.length === 0) errors.push(`\`${at}.models\` must be a non-empty list`);
  }

  // ---- harness (ADR-0028 capability registry) ---------------------------
  const declaredIds = new Set(Object.values(targets).map((t) => t?.id).filter(Boolean));
  if ("harness" in doc) {
    const h = doc.harness ?? {};
    for (const k of Object.keys(h)) {
      if (!HARNESS_KEYS.has(k)) errors.push(`unknown key \`harness.${k}\``);
    }
    if (h.default_model !== undefined) {
      if (typeof h.default_model !== "string" || !h.default_model) {
        errors.push("`harness.default_model` must be a non-empty string");
      } else if (!declaredIds.has(h.default_model)) {
        warnings.push(`\`harness.default_model\` = "${h.default_model}" matches no [targets.*].id — it will be ignored`);
      }
    }
    const policy = h.policy ?? {};
    for (const k of Object.keys(policy)) {
      if (!HARNESS_POLICY_KEYS.has(k)) errors.push(`unknown key \`harness.policy.${k}\``);
    }
    if (policy.deny_glob !== undefined && !(Array.isArray(policy.deny_glob) && policy.deny_glob.every((g) => typeof g === "string"))) {
      errors.push("`harness.policy.deny_glob` must be a list of strings");
    }
    if (policy.min_context_window !== undefined && !(Number.isInteger(policy.min_context_window) && policy.min_context_window >= 0)) {
      errors.push("`harness.policy.min_context_window` must be a non-negative integer");
    }
    if (policy.rank_by_locality !== undefined) {
      if (typeof policy.rank_by_locality !== "object" || policy.rank_by_locality === null) {
        errors.push("`harness.policy.rank_by_locality` must be a table");
      } else {
        for (const [k, v] of Object.entries(policy.rank_by_locality)) {
          if (!LOCALITIES_FOR_RANK.has(k)) errors.push(`unknown key \`harness.policy.rank_by_locality.${k}\` (must be cluster | lan | remote)`);
          else if (typeof v !== "number") errors.push(`\`harness.policy.rank_by_locality.${k}\` must be a number`);
        }
      }
    }
    const overrides = h.overrides ?? {};
    let defaultOverrides = 0;
    for (const [id, ov] of Object.entries(overrides)) {
      const at = `harness.overrides."${id}"`;
      if (!declaredIds.has(id)) warnings.push(`\`${at}\` — "${id}" matches no [targets.*].id; the override will be ignored until it does`);
      if (ov === null || typeof ov !== "object") {
        errors.push(`\`${at}\` must be a table`);
        continue;
      }
      for (const k of Object.keys(ov)) {
        if (!HARNESS_OVERRIDE_KEYS.has(k)) errors.push(`unknown key \`${at}.${k}\``);
      }
      if (ov.enabled !== undefined && typeof ov.enabled !== "boolean") errors.push(`\`${at}.enabled\` must be a boolean`);
      if (ov.rank !== undefined && typeof ov.rank !== "number") errors.push(`\`${at}.rank\` must be a number`);
      if (ov.context_window !== undefined && !(Number.isInteger(ov.context_window) && ov.context_window > 0)) {
        errors.push(`\`${at}.context_window\` must be a positive integer`);
      }
      if (ov.default !== undefined) {
        if (typeof ov.default !== "boolean") errors.push(`\`${at}.default\` must be a boolean`);
        else if (ov.default === true) defaultOverrides++;
      }
      if (ov.capabilities !== undefined) {
        if (typeof ov.capabilities !== "object" || ov.capabilities === null) {
          errors.push(`\`${at}.capabilities\` must be a table`);
        } else {
          for (const [k, v] of Object.entries(ov.capabilities)) {
            if (!HARNESS_CAPABILITY_FLAGS.has(k)) errors.push(`unknown key \`${at}.capabilities.${k}\``);
            else if (typeof v !== "boolean") errors.push(`\`${at}.capabilities.${k}\` must be a boolean`);
          }
        }
      }
    }
    if (defaultOverrides > 1) {
      warnings.push(`\`harness.overrides\` sets \`default = true\` on ${defaultOverrides} entries — only the first one wins`);
    }
  }

  // ---- ingress / placement / discovery ---------------------------------
  for (const k of Object.keys(doc.ingress ?? {})) {
    if (!INGRESS_KEYS.has(k)) errors.push(`unknown key \`ingress.${k}\``);
  }
  for (const [k, v] of Object.entries(doc.ingress ?? {})) {
    if (k.endsWith("_port") && (!Number.isInteger(v) || v < 1 || v > 65535)) {
      errors.push(`\`ingress.${k}\` must be a port in 1..65535`);
    }
  }
  if (doc.placement?.policy !== undefined && !PLACEMENT_POLICIES.has(doc.placement.policy)) {
    errors.push(`\`placement.policy\` must be pair_default | warm_first | vram_aware`);
  }
  for (const s of doc.discovery?.subnets ?? []) {
    const host = String(s).split("/")[0];
    if (!isPrivateHost(host)) {
      errors.push(`\`discovery.subnets\` entry "${s}" is not a private range (RFC 1918 / link-local / ULA)`);
    }
  }
  if (doc.discovery?.lan_scan === true && (doc.discovery.subnets ?? []).length === 0) {
    warnings.push("`discovery.lan_scan = true` with no `subnets` — nothing will be probed");
  }

  // ---- metrics -----------------------------------------------------
  const otlp = doc.metrics?.otlp_endpoint;
  if (typeof otlp === "string" && otlp.length) {
    try {
      const u = new URL(otlp);
      if (u.protocol !== "https:" && !isPrivateHost(u.hostname) && u.hostname !== "localhost") {
        errors.push("`metrics.otlp_endpoint` must be https or loopback");
      }
    } catch {
      errors.push("`metrics.otlp_endpoint` is not a valid URL");
    }
  }

  return { ok: errors.length === 0, errors, warnings, parsed: doc };
}
