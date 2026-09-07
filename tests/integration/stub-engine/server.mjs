// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0
//
// A tiny OpenAI- + Ollama- + Anthropic-compatible echo engine for the
// integration harness. No dependencies (Node stdlib only). It:
//
//   * advertises a fixed model list on GET /v1/models and GET /api/tags,
//   * echoes the last user message on the chat endpoints, streaming or not,
//   * stamps every response with the node name (header `x-served-by` and in
//     the body) so a test can assert which node handled a request,
//   * can be told to fail the first N requests with a status (FAIL_TIMES /
//     FAIL_STATUS) to exercise Yardmaster's 404-retryable failover.
//
// Env: NODE_NAME, PORT (default 8080), MODELS (comma list),
//      FAIL_TIMES (default 0), FAIL_STATUS (default 404).

import { createServer } from "node:http";

const NODE_NAME = process.env.NODE_NAME || "stub";
const PORT = Number(process.env.PORT || 8080);
const MODELS = (process.env.MODELS || "qwen4:12b,qwen4:72b").split(",").map((s) => s.trim());
let failRemaining = Number(process.env.FAIL_TIMES || 0);
const FAIL_STATUS = Number(process.env.FAIL_STATUS || 404);

const json = (res, status, obj, extra = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "x-served-by": NODE_NAME, ...extra });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const lastUser = (body) => {
  const msgs = body.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      return typeof msgs[i].content === "string"
        ? msgs[i].content
        : JSON.stringify(msgs[i].content);
    }
  }
  return body.prompt || "";
};

const reply = (body) => `[${NODE_NAME}] ${lastUser(body)}`;

function sseChat(res, model, text) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "x-served-by": NODE_NAME,
    "cache-control": "no-cache",
  });
  const id = "chatcmpl-stub";
  for (const tok of text.split(/(\s+)/).filter(Boolean)) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { content: tok } }],
      })}\n\n`,
    );
  }
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function ndjsonChat(res, model, text) {
  res.writeHead(200, { "content-type": "application/x-ndjson", "x-served-by": NODE_NAME });
  for (const tok of text.split(/(\s+)/).filter(Boolean)) {
    res.write(JSON.stringify({ model, message: { role: "assistant", content: tok }, done: false }) + "\n");
  }
  res.write(
    JSON.stringify({
      model,
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 7,
      eval_count: text.split(/\s+/).length,
    }) + "\n",
  );
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method === "GET" && p === "/health") return json(res, 200, { status: "ok", node: NODE_NAME });

  if (req.method === "GET" && p === "/v1/models") {
    return json(res, 200, {
      object: "list",
      data: MODELS.map((id) => ({ id, object: "model", owned_by: NODE_NAME })),
    });
  }
  if (req.method === "GET" && p === "/api/tags") {
    return json(res, 200, {
      models: MODELS.map((name) => ({ name, model: name, digest: "deadbeef", size: 1 })),
    });
  }

  const isChat =
    req.method === "POST" &&
    ["/v1/chat/completions", "/v1/responses", "/api/chat", "/api/generate", "/v1/messages"].includes(p);
  if (!isChat) return json(res, 404, { error: "not found", node: NODE_NAME });

  if (failRemaining > 0) {
    failRemaining--;
    return json(res, FAIL_STATUS, { error: `stub forced failure (${failRemaining} left)`, node: NODE_NAME });
  }

  const body = await readBody(req);
  const model = body.model || MODELS[0];
  const text = reply(body);

  if (body.stream) {
    if (p === "/api/chat" || p === "/api/generate") return ndjsonChat(res, model, text);
    return sseChat(res, model, text);
  }

  if (p === "/api/chat" || p === "/api/generate") {
    return json(res, 200, {
      model,
      message: { role: "assistant", content: text },
      done: true,
      prompt_eval_count: 7,
      eval_count: text.split(/\s+/).length,
    });
  }
  if (p === "/v1/messages") {
    return json(res, 200, {
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: text.split(/\s+/).length },
    });
  }
  return json(res, 200, {
    id: "chatcmpl-stub",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: text.split(/\s+/).length, total_tokens: 7 },
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`stub-engine ${NODE_NAME} on :${PORT} models=${MODELS.join(",")} fail=${failRemaining}x${FAIL_STATUS}`);
});
