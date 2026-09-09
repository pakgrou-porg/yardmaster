// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig, resolveRoute, egressAllowed, knownModels } from "../src/router.mjs";

const CFG = `
schema_version = 1
[egress]
allow_remote = true
allow_lan = true
[providers.local]
kind = "openai_compatible"
base_url = "http://127.0.0.1:11434"
[providers.lan]
kind = "openai_compatible"
base_url = "http://10.0.0.9:8000/v1"
[providers.openrouter]
kind = "openrouter"
api_key_env = "OR_KEY_TEST"
[targets]
[targets.small]
id = "llama3.2:latest"
locality = "lan"
provider = "local"
[targets.big]
id = "deepseek-r1:32b"
locality = "lan"
provider = "local"
[targets.remote_qwen]
id = "qwen/qwen3.8-flash"
locality = "remote"
provider = "openrouter"
[routes.default]
id = "auto"
type = "passthrough"
target = "big"
`;

test("direct model-id match routes straight to that target", () => {
  const c = parseConfig(CFG);
  const r = resolveRoute(c, "llama3.2:latest");
  assert.equal(r.ok, true);
  assert.equal(r.chain.length, 1);
  assert.equal(r.chain[0].targetName, "small");
  assert.equal(r.chain[0].baseUrl, "http://127.0.0.1:11434");
  assert.equal(r.decisionReason, "model-name");
});

test("chatUrl adds /v1 for a bare base_url and does not double it for a /v1 one", () => {
  const c = parseConfig(CFG);
  process.env.OR_KEY_TEST = "k";
  assert.equal(
    resolveRoute(c, "llama3.2:latest").chain[0].chatUrl,
    "http://127.0.0.1:11434/v1/chat/completions",
  );
  // provider "openrouter" default base ends in /v1 already
  assert.equal(
    resolveRoute(c, "qwen/qwen3.8-flash").chain[0].chatUrl,
    "https://openrouter.ai/api/v1/chat/completions",
  );
  delete process.env.OR_KEY_TEST;
});

test("unknown model falls through to the default route target", () => {
  const c = parseConfig(CFG);
  const r = resolveRoute(c, "something-nobody-has");
  assert.equal(r.ok, true);
  assert.equal(r.chain[0].targetName, "big");
  assert.equal(r.chain[0].model, "deepseek-r1:32b");
  assert.equal(r.algorithm, "passthrough");
});

test("remote target needs the provider key and allow_remote", () => {
  process.env.OR_KEY_TEST = "sk-or-xxx";
  const r1 = resolveRoute(parseConfig(CFG), "qwen/qwen3.8-flash");
  assert.equal(r1.ok, true);
  assert.equal(r1.chain[0].locality, "remote");
  assert.match(r1.chain[0].baseUrl, /openrouter\.ai/);

  delete process.env.OR_KEY_TEST;
  const r2 = resolveRoute(parseConfig(CFG), "qwen/qwen3.8-flash");
  assert.equal(r2.ok, false);
  assert.match(r2.error, /OR_KEY_TEST/);

  const noRemote = CFG.replace("allow_remote = true", "allow_remote = false");
  process.env.OR_KEY_TEST = "sk-or-xxx";
  const r3 = resolveRoute(parseConfig(noRemote), "qwen/qwen3.8-flash");
  assert.equal(r3.ok, false);
  assert.match(r3.error, /egress.*forbids/);
  delete process.env.OR_KEY_TEST;
});

test("escalation route yields a weak->strong chain", () => {
  const esc = CFG.replace(
    `[routes.default]\nid = "auto"\ntype = "passthrough"\ntarget = "big"`,
    `[routes.default]\nid = "auto"\ntype = "escalation"\nweak_target = "small"\nstrong_target = "big"`,
  );
  const r = resolveRoute(parseConfig(esc), "whatever");
  assert.equal(r.ok, true);
  assert.equal(r.algorithm, "escalation");
  assert.deepEqual(
    r.chain.map((h) => h.targetName),
    ["small", "big"],
  );
});

test("egressAllowed + knownModels", () => {
  assert.equal(egressAllowed("remote", { allow_remote: false }), false);
  assert.equal(egressAllowed("lan", { allow_lan: false }), false);
  assert.equal(egressAllowed("cluster", {}), true);
  const models = knownModels(parseConfig(CFG));
  assert.ok(models.includes("llama3.2:latest") && models.includes("qwen/qwen3.8-flash"));
});
