// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig, resolveRoute, pickWeighted } from "../src/router.mjs";
import {
  taskMessages,
  buildJudgeRequest,
  parseVerdict,
  decideTier,
  classify,
  classificationHeader,
} from "../src/classifier.mjs";
import { CAPABILITY_PROMPT, CAPABILITY_RESPONSE_FORMAT } from "../src/classifier-prompt.mjs";

const CFG = `
schema_version = 1
[egress]
allow_remote = true
[providers.strix]
base_url = "http://127.0.0.1:11434"
[providers.a]
base_url = "http://10.0.0.11:8000/v1"
[providers.b]
base_url = "http://10.0.0.12:8000/v1"
[providers.openrouter]
kind = "openrouter"
api_key_env = "OR_KEY_TEST"
[targets.judge]
id = "llama3.2:latest"
locality = "lan"
provider = "strix"
[targets.mid_a]
id = "mid"
locality = "lan"
provider = "a"
[targets.mid_b]
id = "mid"
locality = "lan"
provider = "b"
[targets.large]
id = "large"
locality = "lan"
provider = "b"
[targets.cloud]
id = "vendor/cloud"
locality = "remote"
provider = "openrouter"
[routes.default]
id = "auto"
type = "passthrough"
target = "mid_a"
[routes.classified]
id = "classified"
type = "llm_classifier"
mode = "capability"
classifier_target = "judge"
weak_target = "mid_a"
strong_target = "large"
base_threshold = 0.6
threshold_step = 0.1
[routes.ab]
id = "ab"
type = "random"
targets = ["mid_a", "large"]
weights = [3, 1]
`;

const verdict = (p, rule = "SUP-1", boundary = "supported") =>
  JSON.stringify({ crux: "the hard part", primary_rule: rule, capability_boundary: boundary, p_solve: p });

test("named routes: model = route id selects that route; target ids still win", () => {
  process.env.OR_KEY_TEST = "x";
  const c = parseConfig(CFG);
  assert.equal(resolveRoute(c, "classified").algorithm, "llm_classifier");
  assert.equal(resolveRoute(c, "ab", { random: () => 0 }).algorithm, "random");
  assert.equal(resolveRoute(c, "mid").routeName, "model-name");
  assert.equal(resolveRoute(c, "something-else").routeName, "auto");
});

test("random: weighted pick, chosen target expands to its replicas", () => {
  assert.equal(pickWeighted(["x", "y"], [3, 1], 0.0), "x");
  assert.equal(pickWeighted(["x", "y"], [3, 1], 0.74), "x");
  assert.equal(pickWeighted(["x", "y"], [3, 1], 0.76), "y");
  assert.equal(pickWeighted(["x", "y"], null, 0.6), "y");
  const r = resolveRoute(parseConfig(CFG), "ab", { random: () => 0.1 });
  assert.deepEqual(r.chain.map((h) => h.targetName), ["mid_a", "mid_b"]);
  assert.equal(resolveRoute(parseConfig(CFG), "ab", { random: () => 0.9 }).chain[0].targetName, "large");
});

test("llm_classifier: resolveRoute leaves a fail-open strong chain and the judge pending", () => {
  const r = resolveRoute(parseConfig(CFG), "classified");
  assert.equal(r.decisionReason, "llm_classifier:pending");
  assert.deepEqual(r.chain.map((h) => h.targetName), ["large"]);
  assert.equal(r.classify.judge.targetName, "judge");
  assert.deepEqual(r.classify.weakChain.map((h) => h.targetName), ["mid_a", "mid_b"]);
});

test("llm_classifier: a remote judge is refused unless judge_egress = allow", () => {
  const remoteJudge = CFG.replace('classifier_target = "judge"', 'classifier_target = "cloud"');
  const r = resolveRoute(parseConfig(remoteJudge), "classified");
  assert.equal(r.classify.judge, null);
  assert.match(r.classify.judgeError, /judge_egress/);
  const allowed = remoteJudge.replace('mode = "capability"', 'mode = "capability"\njudge_egress = "allow"');
  assert.equal(resolveRoute(parseConfig(allowed), "classified").classify.judge.targetName, "cloud");
});

test("taskMessages: opening instruction + latest user follow-up, text only", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "build X" },
    { role: "assistant", content: "ok", tool_calls: [{ id: "1" }] },
    { role: "tool", tool_call_id: "1", content: "result" },
    { role: "user", content: [{ type: "text", text: "now Y" }, { type: "image_url", image_url: { url: "data:," } }] },
  ];
  assert.deepEqual(taskMessages(msgs), [
    { role: "user", content: "build X" },
    { role: "user", content: "now Y" },
  ]);
  assert.deepEqual(taskMessages([{ role: "user", content: "only" }]), [{ role: "user", content: "only" }]);
  const body = buildJudgeRequest("llama3.2:latest", msgs);
  assert.equal(body.messages[0].content, CAPABILITY_PROMPT);
  assert.equal(body.response_format, CAPABILITY_RESPONSE_FORMAT);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.stream, false);
});

test("parseVerdict: accepts the schema (fenced or after <think>), rejects anything else", () => {
  assert.equal(parseVerdict(verdict(0.8)).p_solve, 0.8);
  assert.equal(parseVerdict("<think>hmm {}</think>\n```json\n" + verdict(0.3, "LIM-1", "unsupported") + "\n```").capability_boundary, "unsupported");
  assert.equal(parseVerdict(verdict(1.2)), null);
  assert.equal(parseVerdict(verdict(0.5, "SUP-1", "unsupported")), null); // rule/boundary mismatch
  assert.equal(parseVerdict(JSON.stringify({ crux: "x", primary_rule: "none", capability_boundary: "unmatched", p_solve: 0.5, extra: 1 })), null);
  assert.equal(parseVerdict("I think the weak model can do it"), null);
});

test("decideTier: Switchyard threshold rule; no verdict fails open to strong", () => {
  const t = { base_threshold: 0.6, threshold_step: 0.1 };
  assert.equal(decideTier(parseVerdict(verdict(0.6)), t).tier, "weak"); // supported: threshold 0.6, equal counts as weak
  assert.equal(decideTier(parseVerdict(verdict(0.65, "UNC-1", "uncertain")), t).tier, "strong"); // 0.7
  assert.equal(decideTier(parseVerdict(verdict(0.85, "LIM-2", "unsupported")), t).tier, "weak"); // 0.8
  assert.deepEqual(decideTier(null, t), { tier: "strong", reason: "ambiguous" });
});

test("classify: judge verdict picks the chain; judge failures fail open; header carries no content", async () => {
  const decided = resolveRoute(parseConfig(CFG), "classified");
  const payload = { model: "classified", messages: [{ role: "user", content: "rename a variable" }] };
  let sent;
  const fake = (content, ok = true) => async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content } }] }) };
  };

  const weak = await classify(decided, payload, { fetchImpl: fake(verdict(0.9)) });
  assert.deepEqual(weak.chain.map((h) => h.targetName), ["mid_a", "mid_b"]);
  assert.equal(weak.decisionReason, "llm_classifier:weak");
  assert.equal(sent.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(sent.body.model, "llama3.2:latest");

  const strong = await classify(decided, payload, { fetchImpl: fake(verdict(0.2)) });
  assert.deepEqual(strong.chain.map((h) => h.targetName), ["large"]);
  assert.equal(strong.chain[0].escalated, true);

  const down = await classify(decided, payload, { fetchImpl: fake("", false) });
  assert.equal(down.classification.tier, "strong");
  assert.equal(down.classification.reason, "judge HTTP 500");

  const header = classificationHeader(weak.classification);
  assert.equal(header, "tier=weak; reason=judge; p_solve=0.9; threshold=0.6; rule=SUP-1; boundary=supported");
  assert.ok(!header.includes("hard part")); // the judge's crux never leaves the module
});
