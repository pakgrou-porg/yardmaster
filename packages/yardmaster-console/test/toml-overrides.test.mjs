// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseToml } from "smol-toml";
import { upsertHarnessOverride, generateTargetKey, upsertTarget, removeTarget } from "../src/toml-overrides.mjs";

test("upsertHarnessOverride: creates a new table when none exists, preserving everything else verbatim", () => {
  const before = `# a comment worth keeping\nschema_version = 1\n\n[targets]\n[targets.x]\nid = "m1"\n`;
  const after = upsertHarnessOverride(before, "qwen/qwen3.8-flash", { enabled: true, default: false });
  assert.match(after, /^# a comment worth keeping\nschema_version = 1\n\n\[targets\]\n\[targets\.x\]\nid = "m1"\n/);
  assert.match(after, /\[harness\.overrides\."qwen\/qwen3\.8-flash"\]/);
  assert.match(after, /^enabled = true$/m);
  assert.match(after, /^default = false$/m);
  const doc = parseToml(after);
  assert.equal(doc.harness.overrides["qwen/qwen3.8-flash"].enabled, true);
  assert.equal(doc.harness.overrides["qwen/qwen3.8-flash"].default, false);
});

test("upsertHarnessOverride: updates an existing table in place, leaving other keys and other tables untouched", () => {
  const before =
    `[harness.overrides."qwen/qwen3.8-flash"]\n` +
    `enabled = true\n` +
    `rank = 5\n` +
    `\n` +
    `[harness.overrides."other/model"]\n` +
    `enabled = false\n`;
  const after = upsertHarnessOverride(before, "qwen/qwen3.8-flash", { enabled: false });
  const doc = parseToml(after);
  assert.equal(doc.harness.overrides["qwen/qwen3.8-flash"].enabled, false);
  assert.equal(doc.harness.overrides["qwen/qwen3.8-flash"].rank, 5, "unpatched key untouched");
  assert.equal(doc.harness.overrides["other/model"].enabled, false, "other table untouched");
});

test("upsertHarnessOverride: appends a new key to an existing table without disturbing its neighbors", () => {
  const before = `[harness.overrides."m"]\nenabled = true\n[routes.default]\nid = "d"\n`;
  const after = upsertHarnessOverride(before, "m", { rank: 3 });
  const doc = parseToml(after);
  assert.equal(doc.harness.overrides.m.enabled, true);
  assert.equal(doc.harness.overrides.m.rank, 3);
  assert.equal(doc.routes.default.id, "d");
});

test("upsertHarnessOverride: recognizes a bare (unquoted) key form too", () => {
  const before = `[harness.overrides.local_r1_32b]\nenabled = true\n`;
  const after = upsertHarnessOverride(before, "local_r1_32b", { default: true });
  const doc = parseToml(after);
  assert.equal(doc.harness.overrides.local_r1_32b.enabled, true);
  assert.equal(doc.harness.overrides.local_r1_32b.default, true);
});

test("upsertHarnessOverride: is idempotent — writing the same patch twice yields the same table content", () => {
  let text = `schema_version = 1\n`;
  text = upsertHarnessOverride(text, "a/b", { enabled: true, rank: 1 });
  const once = text;
  text = upsertHarnessOverride(text, "a/b", { enabled: true, rank: 1 });
  assert.equal(text, once);
});

test("upsertHarnessOverride: an id needing escaping round-trips through a real TOML parser", () => {
  const before = `schema_version = 1\n`;
  const after = upsertHarnessOverride(before, 'weird "id" \\with\\ escapes', { enabled: true });
  const doc = parseToml(after);
  assert.equal(doc.harness.overrides['weird "id" \\with\\ escapes'].enabled, true);
});

test("upsertHarnessOverride: an empty patch is a no-op", () => {
  const before = `schema_version = 1\n`;
  assert.equal(upsertHarnessOverride(before, "m", {}), before);
});

// ---------------------------------------------------------------------------
// [targets.<key>] — generateTargetKey / upsertTarget / removeTarget (P5)
// ---------------------------------------------------------------------------

test("generateTargetKey: slugifies provider + id, collapsing non-alphanumerics to underscores", () => {
  const raw = `schema_version = 1\n[targets]\n`;
  assert.equal(generateTargetKey(raw, "openrouter", "openai/gpt-5.6-terra"), "openrouter_openai_gpt_5_6_terra");
});

test("generateTargetKey: dedupes against an existing bareword key by appending _2, _3", () => {
  const raw = `[targets.local_ollama_a]\nid = "a"\n[targets.local_ollama_a_2]\nid = "b"\n`;
  assert.equal(generateTargetKey(raw, "local_ollama", "a"), "local_ollama_a_3");
});

test("generateTargetKey: dedupes against an existing quoted-string key too", () => {
  const raw = `[targets."or_x"]\nid = "x"\n`;
  assert.equal(generateTargetKey(raw, "or", "x"), "or_x_2");
});

test("upsertTarget: creates a new [targets.<key>] table, preserving everything else verbatim", () => {
  const before = `# a comment worth keeping\nschema_version = 1\n\n[targets]\n[targets.x]\nid = "m1"\n`;
  const after = upsertTarget(before, "or_new_model", { id: "new/model", provider: "openrouter", locality: "remote" });
  assert.match(after, /^# a comment worth keeping\nschema_version = 1\n\n\[targets\]\n\[targets\.x\]\nid = "m1"\n/);
  const doc = parseToml(after);
  assert.equal(doc.targets.or_new_model.id, "new/model");
  assert.equal(doc.targets.or_new_model.provider, "openrouter");
  assert.equal(doc.targets.or_new_model.locality, "remote");
});

test("upsertTarget: updates an existing target table in place without touching other tables", () => {
  const before = `[targets.x]\nid = "m1"\nlocality = "lan"\n[targets.y]\nid = "m2"\n`;
  const after = upsertTarget(before, "x", { locality: "cluster" });
  const doc = parseToml(after);
  assert.equal(doc.targets.x.id, "m1", "unpatched key untouched");
  assert.equal(doc.targets.x.locality, "cluster");
  assert.equal(doc.targets.y.id, "m2", "other table untouched");
});

test("upsertTarget: throws TypeError if key is not a bare-safe identifier", () => {
  assert.throws(() => upsertTarget(`schema_version = 1\n`, "a/b", { id: "x" }), TypeError);
});

test("upsertTarget: an empty patch is a no-op", () => {
  const before = `schema_version = 1\n`;
  assert.equal(upsertTarget(before, "m", {}), before);
});

test("removeTarget: deletes an existing bareword-keyed target table, leaving a same-id override untouched", () => {
  const before = `[harness.overrides."m/1"]\nenabled = true\n[targets.x]\nid = "m/1"\nprovider = "p"\n[targets.y]\nid = "m2"\n`;
  const after = removeTarget(before, "x");
  const doc = parseToml(after);
  assert.equal(doc.targets.x, undefined);
  assert.equal(doc.targets.y.id, "m2", "other target untouched");
  assert.equal(doc.harness.overrides["m/1"].enabled, true, "orphaned override left in place");
});

test("removeTarget: deletes an existing quoted-keyed target table", () => {
  const before = `[targets."weird key"]\nid = "m"\n[targets.y]\nid = "m2"\n`;
  const doc = parseToml(removeTarget(before, "weird key"));
  assert.equal(doc.targets["weird key"], undefined);
  assert.equal(doc.targets.y.id, "m2");
});

test("removeTarget: is a no-op (returns input unchanged) when the key doesn't exist", () => {
  const before = `[targets.x]\nid = "m"\n`;
  assert.equal(removeTarget(before, "nope"), before);
});

test("upsertTarget + removeTarget: set then unset leaves the file byte-identical to before set", () => {
  const before = `schema_version = 1\n\n[providers.openrouter]\n`;
  const key = generateTargetKey(before, "openrouter", "a/b");
  const after = upsertTarget(before, key, { id: "a/b", provider: "openrouter", locality: "remote" });
  assert.notEqual(after, before);
  assert.equal(removeTarget(after, key), before);
});
