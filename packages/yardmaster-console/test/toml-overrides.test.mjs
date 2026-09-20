// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseToml } from "smol-toml";
import { upsertHarnessOverride, upsertHarnessPolicy } from "../src/toml-overrides.mjs";

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

test("upsertHarnessPolicy: creates [harness.policy] when none exists, preserving everything else verbatim", () => {
  const before = `# comment\nschema_version = 1\n\n[targets]\n[targets.x]\nid = "m1"\n`;
  const after = upsertHarnessPolicy(before, { require_approval: true });
  assert.match(after, /^# comment\nschema_version = 1\n\n\[targets\]\n\[targets\.x\]\nid = "m1"\n/);
  assert.match(after, /^\[harness\.policy\]$/m);
  assert.match(after, /^require_approval = true$/m);
  const doc = parseToml(after);
  assert.equal(doc.harness.policy.require_approval, true);
});

test("upsertHarnessPolicy: updates an existing table in place, leaving other keys and [harness.overrides.*] untouched", () => {
  const before =
    `[harness.policy]\n` +
    `smoke_test = true\n` +
    `\n` +
    `[harness.overrides."m"]\n` +
    `enabled = true\n`;
  const after = upsertHarnessPolicy(before, { require_approval: true });
  const doc = parseToml(after);
  assert.equal(doc.harness.policy.smoke_test, true, "unpatched key untouched");
  assert.equal(doc.harness.policy.require_approval, true);
  assert.equal(doc.harness.overrides.m.enabled, true, "override table untouched");
});

test("upsertHarnessPolicy: flipping the same key back off overwrites in place, not a duplicate table", () => {
  let text = `schema_version = 1\n`;
  text = upsertHarnessPolicy(text, { require_approval: true });
  text = upsertHarnessPolicy(text, { require_approval: false });
  assert.equal((text.match(/^\[harness\.policy\]$/gm) || []).length, 1);
  const doc = parseToml(text);
  assert.equal(doc.harness.policy.require_approval, false);
});

test("upsertHarnessPolicy: an empty patch is a no-op", () => {
  const before = `schema_version = 1\n`;
  assert.equal(upsertHarnessPolicy(before, {}), before);
});
