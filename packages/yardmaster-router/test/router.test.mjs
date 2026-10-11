// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig, resolveRoute, egressAllowed, knownModels, sniffUsage } from "../src/router.mjs";

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

test("sniffUsage parses nested usage (non-stream), SSE stream, OpenRouter cost", () => {
  // non-stream OpenAI/Ollama with nested prompt_tokens_details
  const nonStream = JSON.stringify({
    choices: [{ message: { content: "ok" } }],
    usage: { prompt_tokens: 41, completion_tokens: 12, total_tokens: 53, prompt_tokens_details: { cached_tokens: 15 } },
  });
  let u = sniffUsage(nonStream);
  assert.equal(u.prompt_tokens, 41);
  assert.equal(u.completion_tokens, 12);
  assert.equal(u.cached_tokens, 15);

  // OpenRouter reports cost in usage
  u = sniffUsage(JSON.stringify({ usage: { prompt_tokens: 15, completion_tokens: 39, cost: 0.0021 } }));
  assert.equal(u.cost, 0.0021);
  assert.equal(u.completion_tokens, 39);

  // SSE stream: usage only in the final chunk
  const sse =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":3,"completion_tokens_details":{"reasoning_tokens":1}}}\n\n' +
    "data: [DONE]\n\n";
  u = sniffUsage(sse);
  assert.equal(u.prompt_tokens, 7);
  assert.equal(u.completion_tokens, 3);

  // nothing parseable
  assert.deepEqual(sniffUsage("garbage"), { prompt_tokens: 0, completion_tokens: 0, cached_tokens: null, cost: null });
});

// ADR-0029 — node topology + replicas: Strix Halo, two GB10s, and the GB10
// pair as one engine sharded over their QSFP link.
const TOPO = `
schema_version = 1
[egress]
allow_remote = true
[nodes.strix]
accelerator = "strix_halo"
memory_gb = 128
[nodes.gb10_a]
accelerator = "gb10"
memory_gb = 128
fabric = "qsfp"
[nodes.gb10_b]
accelerator = "gb10"
memory_gb = 128
fabric = "qsfp"
[providers.strix_ollama]
base_url = "http://127.0.0.1:11434"
nodes = ["strix"]
[providers.gb10_a_vllm]
base_url = "http://10.0.0.11:8000/v1"
nodes = ["gb10_a"]
[providers.gb10_b_vllm]
base_url = "http://10.0.0.12:8000/v1"
nodes = ["gb10_b"]
[providers.gb10_pair_vllm]
base_url = "http://10.0.0.11:8010/v1"
nodes = ["gb10_a", "gb10_b"]
[providers.openrouter]
kind = "openrouter"
api_key_env = "OR_KEY_TEST"
[targets.mid_a]
id = "qwen3.6-35b-a3b"
locality = "lan"
provider = "gb10_a_vllm"
[targets.mid_b]
id = "qwen3.6-35b-a3b"
locality = "lan"
provider = "gb10_b_vllm"
[targets.mid_cloud]
id = "qwen3.6-35b-a3b"
locality = "remote"
provider = "openrouter"
[targets.huge]
id = "qwen3.8-235b-a22b"
locality = "lan"
provider = "gb10_pair_vllm"
[targets.small]
id = "llama3.2:latest"
locality = "lan"
provider = "strix_ollama"
[routes.default]
id = "auto"
type = "passthrough"
target = "mid_a"
`;

test("providerPlacement: single node, the GB10 pair over its fabric, and none", async () => {
  const { providerPlacement } = await import("../src/router.mjs");
  const c = parseConfig(TOPO);
  assert.deepEqual(providerPlacement("gb10_a_vllm", c), {
    nodes: ["gb10_a"], span: "single", accelerators: ["gb10"], memory_gb: 128, fabric: null,
  });
  assert.deepEqual(providerPlacement("gb10_pair_vllm", c), {
    nodes: ["gb10_a", "gb10_b"], span: "multi", accelerators: ["gb10"], memory_gb: 256, fabric: "qsfp",
  });
  assert.equal(providerPlacement("openrouter", c), null);
});

test("replicas: a model on both GB10s fails over between them, never to the remote copy", () => {
  process.env.OR_KEY_TEST = "x";
  const r = resolveRoute(parseConfig(TOPO), "qwen3.6-35b-a3b");
  assert.equal(r.ok, true);
  assert.deepEqual(r.chain.map((h) => h.targetName), ["mid_a", "mid_b"]);
  assert.deepEqual(r.chain.map((h) => h.nodes), [["gb10_a"], ["gb10_b"]]);
  // the default route expands to replicas too
  const d = resolveRoute(parseConfig(TOPO), "anything");
  assert.deepEqual(d.chain.map((h) => h.targetName), ["mid_a", "mid_b"]);
});

test("replicas: a replica the registry last saw unreachable is tried last", () => {
  const health = new Map([["mid_a", "unreachable"], ["mid_b", "validated"]]);
  const r = resolveRoute(parseConfig(TOPO), "qwen3.6-35b-a3b", { health });
  assert.deepEqual(r.chain.map((h) => h.targetName), ["mid_b", "mid_a"]);
});

test("replicas: the pair-spanning target is a normal single hop carrying both nodes", () => {
  const r = resolveRoute(parseConfig(TOPO), "qwen3.8-235b-a22b");
  assert.equal(r.chain.length, 1);
  assert.deepEqual(r.chain[0].nodes, ["gb10_a", "gb10_b"]);
});

test("escalation: weak/strong hops are tagged so replica failover isn't counted as escalation", () => {
  const esc = TOPO.replace(
    /\[routes\.default\][\s\S]*$/,
    `[routes.default]\nid = "auto"\ntype = "escalation"\nweak_target = "mid_a"\nstrong_target = "huge"\n`,
  );
  const r = resolveRoute(parseConfig(esc), "whatever");
  assert.deepEqual(r.chain.map((h) => [h.targetName, h.escalated]), [["mid_a", false], ["mid_b", false], ["huge", true]]);
});
