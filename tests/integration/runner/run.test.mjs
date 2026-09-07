// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0
//
// Integration scenarios. Uses node:test (no dependencies). Two phases:
//
//   Phase 1 (runs now): the stub engines are reachable and behave, which
//     verifies the Compose harness itself.
//   Phase 2 (test.todo): the two-stage-router scenarios from issue #34. They
//     need the yardmaster-dataplane binary (#25) and the broker wiring (#26);
//     until then they are recorded here as todos so the list is visible.
//
// Env: ENGINE_A_URL, ENGINE_B_URL (Phase 1); YARDMASTER_A_URL, YARDMASTER_B_URL
// (Phase 2).

import test from "node:test";
import assert from "node:assert/strict";

const A = process.env.ENGINE_A_URL || "http://engine-a:8080";
const B = process.env.ENGINE_B_URL || "http://engine-b:8080";

const get = async (u) => {
  const r = await fetch(u);
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const post = async (u, obj) => {
  const r = await fetch(u, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, body: ct.includes("json") ? await r.json() : await r.text() };
};

test("phase 1: both stub engines advertise their models", async () => {
  for (const [name, url] of [["A", A], ["B", B]]) {
    const { status, body } = await get(`${url}/v1/models`);
    assert.equal(status, 200, `${name} /v1/models`);
    assert.ok(body.data.some((m) => m.id === "qwen4:12b"), `${name} advertises qwen4:12b`);
  }
});

test("phase 1: /api/tags is served on both", async () => {
  for (const url of [A, B]) {
    const { status, body } = await get(`${url}/api/tags`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.models) && body.models.length > 0);
  }
});

test("phase 1: chat echoes and stamps the serving node", async () => {
  const { status, headers, body } = await post(`${A}/v1/chat/completions`, {
    model: "qwen4:12b",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(status, 200);
  assert.equal(headers.get("x-served-by"), "engine-a");
  assert.match(body.choices[0].message.content, /\[engine-a\] hello/);
});

test("phase 1: SSE streaming terminates with [DONE]", async () => {
  const r = await fetch(`${A}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "a b c" }] }),
  });
  const text = await r.text();
  assert.match(text, /data: \[DONE\]/);
});

test("phase 1: forced-failure engine returns its configured status", async () => {
  // engine-b is started with FAIL_TIMES=1 FAIL_STATUS=404 in the compose file.
  const first = await post(`${B}/v1/chat/completions`, { messages: [{ role: "user", content: "x" }] });
  assert.equal(first.status, 404, "first request to engine-b fails once");
  const second = await post(`${B}/v1/chat/completions`, { messages: [{ role: "user", content: "x" }] });
  assert.equal(second.status, 200, "engine-b recovers on the next request");
});

// ---- Phase 2: the two-stage-router scenarios (issue #34) -------------------
test.todo("pairing two Yardmaster nodes via the six-digit PIN over the real cluster manager");
test.todo("passthrough request routed to the node holding the model");
test.todo("stage_router tool-error signal escalates to a model that exists only on node B");
test.todo("failover on stale inventory: 404 from node A retries on node B");
test.todo("mTLS rejection of an unpinned client at the handshake");
test.todo("403 on non-loopback plaintext to an ingress port");
test.todo("/v1/models fan-out merges both nodes' inventories");
test.todo("Anthropic Messages ingress served by an OpenAI-compatible stub, with streaming");
test.todo("allow_remote = false blocks a remote target at config load");
test.todo("dsh headless --profile yardmaster-headless: planner step on node A, worker steps on node B, matching session_id");
