// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/router.mjs";
import {
  parseHarnessConfig,
  discover,
  applyProbeResults,
  applyPolicy,
  selectDefault,
  desiredEntries,
  renderRegion,
  splitRegion,
  parseAppliedRegion,
  planApply,
  runPipeline,
  probeCapabilitySources,
  writeManagedRegion,
} from "../src/capabilities.mjs";

const CFG = `
schema_version = 1
[egress]
allow_remote = true
[providers.local]
kind = "openai_compatible"
base_url = "http://127.0.0.1:19601"
[providers.openrouter]
kind = "openrouter"
api_key_env = "CAP_TEST_OR_KEY"
[targets]
[targets.small]
id = "llama3.2:latest"
locality = "lan"
provider = "local"
[targets.big]
id = "deepseek-r1:32b"
locality = "lan"
provider = "local"
[targets.cloud_free]
id = "vendor/free-model"
locality = "remote"
provider = "openrouter"
[targets.cloud_pro]
id = "vendor/pro-model"
locality = "remote"
provider = "openrouter"
[routes.default]
id = "auto"
type = "passthrough"
target = "big"
`;

function baseProbeMap() {
  const local = new Map([
    ["llama3.2:latest", { context_length: 8192, pricing: null }],
    ["deepseek-r1:32b", { context_length: 32768, pricing: null }],
  ]);
  const openrouter = new Map([
    ["vendor/free-model", { context_length: 32000, pricing: { in: 0, out: 0 } }],
    ["vendor/pro-model", { context_length: 200000, pricing: { in: 3, out: 15 } }],
  ]);
  return new Map([
    ["local", { ok: true, checkedMs: 1000, models: local }],
    ["openrouter", { ok: true, checkedMs: 1000, models: openrouter }],
  ]);
}

test("discover: one Capability per declared target, seeded from TOML", () => {
  const config = parseConfig(CFG);
  const records = discover(config);
  assert.equal(records.size, 4);
  const big = records.get("deepseek-r1:32b");
  assert.equal(big.target, "big");
  assert.equal(big.provider, "local");
  assert.equal(big.locality, "lan");
  assert.equal(big.source, "declared");
  assert.equal(big.reachability, "discovered");
  assert.equal(big.policy, "enabled");
});

test("applyProbeResults: validated / unreachable / probed-only", () => {
  const config = parseConfig(CFG);
  let records = discover(config);
  const probeMap = baseProbeMap();
  // drop one declared id from the provider's live list -> unreachable
  probeMap.get("openrouter").models.delete("vendor/pro-model");
  // add an undeclared model -> probed-only, always disabled
  probeMap.get("openrouter").models.set("vendor/undeclared-model", { context_length: 4096, pricing: null });

  records = applyProbeResults(records, probeMap);
  assert.equal(records.get("deepseek-r1:32b").reachability, "validated");
  assert.equal(records.get("deepseek-r1:32b").context_window, 32768);
  assert.equal(records.get("vendor/pro-model").reachability, "unreachable");
  assert.equal(records.get("vendor/free-model").pricing_usd_per_mtok.in, 0);

  const probed = records.get("vendor/undeclared-model");
  assert.equal(probed.source, "probed");
  assert.equal(probed.target, null);
  assert.equal(probed.policy, "disabled");
  assert.equal(probed.policy_reason, "not declared as a target");
});

test("applyProbeResults: a provider that fails to answer marks its ids unreachable", () => {
  const config = parseConfig(CFG);
  let records = discover(config);
  const probeMap = new Map([
    ["local", { ok: false, checkedMs: 1, models: new Map() }],
    ["openrouter", { ok: true, checkedMs: 1, models: baseProbeMap().get("openrouter").models }],
  ]);
  records = applyProbeResults(records, probeMap);
  assert.equal(records.get("llama3.2:latest").reachability, "unreachable");
  assert.equal(records.get("deepseek-r1:32b").reachability, "unreachable");
  assert.equal(records.get("vendor/free-model").reachability, "validated");
});

test("applyPolicy: deny_glob, min_context_window, and overrides winning over policy", () => {
  const config = parseConfig(CFG);
  let records = discover(config);
  records = applyProbeResults(records, baseProbeMap());
  const harnessCfg = parseHarnessConfig({
    harness: {
      policy: { deny_glob: ["vendor/free-*"], min_context_window: 16000, rank_by_locality: { lan: 0, remote: 50 } },
      overrides: { "llama3.2:latest": { enabled: false }, "vendor/free-model": { enabled: true, rank: 1 } },
    },
  });
  records = applyPolicy(records, harnessCfg);

  // denied by glob, but the override re-enables it and wins
  assert.equal(records.get("vendor/free-model").policy, "enabled");
  assert.equal(records.get("vendor/free-model").policy_reason, "operator override");
  assert.equal(records.get("vendor/free-model").rank, 1);

  // below min_context_window (8192 < 16000) -> disabled by policy, no override
  assert.equal(records.get("llama3.2:latest").policy, "disabled");
  assert.equal(records.get("llama3.2:latest").policy_reason, "operator override"); // explicit override also set here

  // untouched target, above min context, not denied -> stays enabled
  assert.equal(records.get("deepseek-r1:32b").policy, "enabled");
});

test("applyPolicy: min_context_window disables without an override", () => {
  const config = parseConfig(CFG);
  let records = discover(config);
  records = applyProbeResults(records, baseProbeMap());
  const harnessCfg = parseHarnessConfig({ harness: { policy: { min_context_window: 16000 } } });
  records = applyPolicy(records, harnessCfg);
  assert.equal(records.get("llama3.2:latest").policy, "disabled");
  assert.equal(records.get("llama3.2:latest").policy_reason, "policy: min_context_window");
});

test("selectDefault: override default:true > harness.default_model > routes.default > best-local", () => {
  const config = parseConfig(CFG);
  const build = (harnessRaw) => {
    let records = discover(config);
    records = applyProbeResults(records, baseProbeMap());
    const harnessCfg = parseHarnessConfig({ harness: harnessRaw || {} });
    records = applyPolicy(records, harnessCfg);
    return { records, harnessCfg };
  };

  // nothing set -> falls to routes.default ("big")
  {
    const { records, harnessCfg } = build({});
    const d = selectDefault(records, config, harnessCfg);
    assert.equal(d.id, "deepseek-r1:32b");
    assert.equal(d.source, "routes.default");
  }
  // harness.default_model wins over routes.default
  {
    const { records, harnessCfg } = build({ default_model: "llama3.2:latest" });
    const d = selectDefault(records, config, harnessCfg);
    assert.equal(d.id, "llama3.2:latest");
    assert.equal(d.source, "harness.default_model");
  }
  // an override default:true wins over everything
  {
    const { records, harnessCfg } = build({
      default_model: "llama3.2:latest",
      overrides: { "vendor/pro-model": { default: true } },
    });
    const d = selectDefault(records, config, harnessCfg);
    assert.equal(d.id, "vendor/pro-model");
    assert.equal(d.source, "override");
  }
});

test("render + parse round-trip; region write leaves surrounding content untouched", () => {
  const entries = [
    { id: "llama3.2:latest", contextWindow: 8192 },
    { id: "vendor/pro-model", contextWindow: undefined },
  ];
  const text = renderRegion(entries, "llama3.2:latest", "http://127.0.0.1:4000/v1");
  const split = splitRegion(`before\n${text}after\n`);
  assert.equal(split.before, "before\n");
  // raw split: whatever followed the marker in the source text, verbatim
  // (writeManagedRegion is what normalises the leading blank line away).
  assert.equal(split.after, "\nafter\n");

  const parsed = parseAppliedRegion(text);
  assert.deepEqual(
    parsed.entries.map((e) => e.id),
    ["llama3.2:latest", "vendor/pro-model"],
  );
  assert.equal(parsed.entries[0].contextWindow, 8192);
  assert.equal(parsed.defaultId, "llama3.2:latest");
});

test("planApply: additive add always applies; a policy-driven remove is held; an override-driven remove auto-applies", () => {
  const previous = { entries: [{ id: "a" }, { id: "b" }], defaultId: "a" };
  const recordsById = new Map([
    ["a", { policy: "enabled", policy_reason: null }], // still desired
    ["b", { policy: "disabled", policy_reason: "policy: deny_glob" }], // world/policy-driven removal -> held
  ]);
  const desired = {
    entries: [{ id: "a" }, { id: "c" }], // b dropped, c added
    defaultId: "a",
    defaultSource: "routes.default",
    recordsById,
  };
  const { appliedEntries, pendingOps } = planApply(previous, desired);
  const ids = appliedEntries.map((e) => e.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"], "held removal keeps b listed");
  assert.equal(pendingOps.length, 1);
  assert.equal(pendingOps[0].type, "remove");
  assert.equal(pendingOps[0].id, "b");

  // now b's removal is override-driven -> auto-applies, no pending op
  recordsById.set("b", { policy: "disabled", policy_reason: "operator override" });
  const r2 = planApply(previous, desired);
  assert.deepEqual(
    r2.appliedEntries.map((e) => e.id).sort(),
    ["a", "c"],
  );
  assert.equal(r2.pendingOps.length, 0);
});

test("planApply: default change from an explicit source auto-applies; a fallback-guess change is held", () => {
  const previous = { entries: [{ id: "a" }, { id: "b" }], defaultId: "a" };
  const recordsById = new Map([
    ["a", { policy: "enabled", policy_reason: null }],
    ["b", { policy: "enabled", policy_reason: null }],
  ]);
  const explicit = { entries: previous.entries, defaultId: "b", defaultSource: "harness.default_model", recordsById };
  const r1 = planApply(previous, explicit);
  assert.equal(r1.appliedDefaultId, "b");
  assert.equal(r1.pendingOps.length, 0);

  const guess = { entries: previous.entries, defaultId: "b", defaultSource: "best-local", recordsById };
  const r2 = planApply(previous, guess);
  assert.equal(r2.appliedDefaultId, "a", "kept the old default until approved");
  assert.equal(r2.pendingOps.length, 1);
  assert.equal(r2.pendingOps[0].type, "default-change");
});

test("runPipeline: end-to-end wiring produces a coherent plan", () => {
  const config = parseConfig(CFG);
  const { desired, plan } = runPipeline(config, baseProbeMap(), parseHarnessConfig(config), null);
  assert.ok(desired.entries.length >= 3);
  assert.equal(plan.pendingOps.length, 0, "first-ever reconcile: everything is additive");
  assert.ok(plan.appliedEntries.some((e) => e.id === "deepseek-r1:32b"));
});

test("probeCapabilitySources: reads ids + context_length + pricing from a live /v1/models", async (t) => {
  const srv = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "vendor/model-a", context_length: 131072, pricing: { prompt: "0.000003", completion: "0.000015" } },
            { id: "vendor/model-b" },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  t.after(() => srv.close());

  const config = parseConfig(`
schema_version = 1
[providers.p]
kind = "openai_compatible"
base_url = "http://127.0.0.1:${port}"
[targets]
[targets.x]
id = "vendor/model-a"
locality = "lan"
provider = "p"
`);
  const probeMap = await probeCapabilitySources(config, { timeoutMs: 2000 });
  const p = probeMap.get("p");
  assert.equal(p.ok, true);
  assert.equal(p.models.get("vendor/model-a").context_length, 131072);
  assert.ok(Math.abs(p.models.get("vendor/model-a").pricing.in - 3) < 1e-6);
  assert.ok(Math.abs(p.models.get("vendor/model-a").pricing.out - 15) < 1e-6);
  assert.equal(p.models.get("vendor/model-b").context_length, null);
});

test("writeManagedRegion: a bare dsh boilerplate '[]' never survives as an invalid-YAML prefix", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymcap-"));
  const patchPath = join(dir, "cordis.patch.yml");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    patchPath,
    "# Your patch layer for this dsh profile, applied after every bundle layer:\n[]\n",
  );
  const r = await writeManagedRegion({
    patchPath,
    entries: [{ id: "m1" }],
    defaultId: "m1",
    upstream: "http://127.0.0.1:4000/v1",
    validate: async () => ({ ok: true }),
  });
  assert.equal(r.applied, true);
  const text = readFileSync(patchPath, "utf8");
  assert.doesNotMatch(text, /^\[\]/, "the bare [] boilerplate was dropped, not kept as a prefix");
  assert.match(text, /^# BEGIN yardmaster-managed/);

  // real user content ahead of the region (no boilerplate) is kept verbatim.
  const dir2 = mkdtempSync(join(tmpdir(), "ymcap-"));
  const patchPath2 = join(dir2, "cordis.patch.yml");
  t.after(() => rmSync(dir2, { recursive: true, force: true }));
  writeFileSync(patchPath2, "- id: my-plugin\n  disabled: true\n");
  await writeManagedRegion({
    patchPath: patchPath2,
    entries: [{ id: "m1" }],
    defaultId: "m1",
    upstream: "http://127.0.0.1:4000/v1",
    validate: async () => ({ ok: true }),
  });
  const text2 = readFileSync(patchPath2, "utf8");
  assert.match(text2, /^- id: my-plugin/);
});

test("writeManagedRegion: gated write self-heals from .lkg on a rejected validation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymcap-"));
  const patchPath = join(dir, "cordis.patch.yml");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // seed a "good" file with a user section the pipeline must never touch.
  writeFileSync(patchPath, "- id: my-own-plugin\n  disabled: true\n");

  const ok1 = await writeManagedRegion({
    patchPath,
    entries: [{ id: "m1", contextWindow: 4096 }],
    defaultId: "m1",
    upstream: "http://127.0.0.1:4000/v1",
    validate: async () => ({ ok: true }),
  });
  assert.equal(ok1.applied, true);
  let text = readFileSync(patchPath, "utf8");
  assert.match(text, /my-own-plugin/);
  assert.match(text, /id: "m1"/);
  const goodText = text;

  // a bad write is rejected and rolled back to the prior (good) content.
  const bad = await writeManagedRegion({
    patchPath,
    entries: [{ id: "m2" }],
    defaultId: "m2",
    upstream: "http://127.0.0.1:4000/v1",
    validate: async () => ({ ok: false, error: "boom: invalid config" }),
  });
  assert.equal(bad.applied, false);
  assert.equal(bad.rolledBack, true);
  text = readFileSync(patchPath, "utf8");
  assert.equal(text, goodText, "rolled back to the last-known-good content");
  assert.doesNotMatch(text, /id: "m2"/);

  // an unchanged write (same entries) is a no-op, not a fresh write — and
  // stays a no-op on repeated reconciles (no blank-line accumulation).
  for (let i = 0; i < 3; i++) {
    const noop = await writeManagedRegion({
      patchPath,
      entries: [{ id: "m1", contextWindow: 4096 }],
      defaultId: "m1",
      upstream: "http://127.0.0.1:4000/v1",
      validate: async () => ({ ok: true }),
    });
    assert.equal(noop.unchanged, true, `iteration ${i}`);
  }
  assert.equal(readFileSync(patchPath, "utf8"), goodText);
});
