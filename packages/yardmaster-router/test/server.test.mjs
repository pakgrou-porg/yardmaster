// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STUB = fileURLToPath(new URL("../../../tests/integration/stub-engine/server.mjs", import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const startStub = (port, models, name) =>
  spawn(process.execPath, [STUB], {
    env: { ...process.env, NODE_NAME: name, PORT: String(port), MODELS: models },
    stdio: "ignore",
  });

test("router: routes by model id, records a metric, serves /v1/models", async (t) => {
  const a = startStub(19301, "llama3.2:latest", "engine-A");
  const b = startStub(19302, "deepseek-r1:32b", "engine-B");
  const dir = mkdtempSync(join(tmpdir(), "ymr-"));
  const cfgPath = join(dir, "yardmaster.toml");
  const dbPath = join(dir, "m.db");
  writeFileSync(
    cfgPath,
    `schema_version = 1
[egress]
allow_remote = false
[providers.a]
kind = "openai_compatible"
base_url = "http://127.0.0.1:19301/v1"
[providers.b]
kind = "openai_compatible"
base_url = "http://127.0.0.1:19302/v1"
[targets]
[targets.small]
id = "llama3.2:latest"
locality = "lan"
provider = "a"
[targets.big]
id = "deepseek-r1:32b"
locality = "lan"
provider = "b"
[routes.default]
id = "auto"
type = "passthrough"
target = "big"
`,
  );

  const srv = spawn(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      YM_ROUTER_PORT: "19300",
      YM_ROUTER_BIND: "127.0.0.1",
      YM_ROUTER_CONFIG: cfgPath,
      YM_METRICS_DB: dbPath,
    },
    stdio: "ignore",
  });
  t.after(() => {
    a.kill();
    b.kill();
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  await wait(700);

  const R = "http://127.0.0.1:19300";

  // /v1/models lists both target ids
  const models = await (await fetch(`${R}/v1/models`)).json();
  const ids = models.data.map((m) => m.id);
  assert.ok(ids.includes("llama3.2:latest") && ids.includes("deepseek-r1:32b"));

  // direct id -> engine A (the stub stamps x-served-by)
  const r1 = await fetch(`${R}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "llama3.2:latest", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("x-served-by"), "engine-A");

  // unknown model -> default route -> engine B
  const r2 = await fetch(`${R}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "no-such-model", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  assert.equal(r2.headers.get("x-served-by"), "engine-B");

  await wait(200);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare("SELECT route, node_or_provider, model, http_status FROM events ORDER BY ts_ms").all();
  db.close();
  assert.equal(rows.length, 2, JSON.stringify(rows));
  assert.equal(rows[0].node_or_provider, "a");
  assert.equal(rows[1].node_or_provider, "b");
  assert.equal(rows[1].route, "auto");
});

test("router: escalation fails over from a dead weak target to a live strong one", async (t) => {
  const good = startStub(19402, "big", "engine-strong");
  const dir = mkdtempSync(join(tmpdir(), "ymr-"));
  const cfgPath = join(dir, "yardmaster.toml");
  writeFileSync(
    cfgPath,
    `schema_version = 1
[providers.dead]
kind = "openai_compatible"
base_url = "http://127.0.0.1:1/v1"
[providers.strong]
kind = "openai_compatible"
base_url = "http://127.0.0.1:19402/v1"
[targets]
[targets.weak]
id = "weakm"
locality = "lan"
provider = "dead"
[targets.strong]
id = "strongm"
locality = "lan"
provider = "strong"
[routes.default]
id = "esc"
type = "escalation"
weak_target = "weak"
strong_target = "strong"
`,
  );
  const srv = spawn(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], {
    env: { ...process.env, YM_ROUTER_PORT: "19400", YM_ROUTER_CONFIG: cfgPath, YM_METRICS_DB: join(dir, "m.db") },
    stdio: "ignore",
  });
  t.after(() => {
    good.kill();
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  await wait(700);

  const r = await fetch("http://127.0.0.1:19400/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anything", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-served-by"), "engine-strong");
});

test("router: retries a 429 on the same hop and eventually succeeds", async (t) => {
  const flaky = spawn(process.execPath, [STUB], {
    env: { ...process.env, NODE_NAME: "engine-flaky", PORT: "19502", MODELS: "m", FAIL_TIMES: "2", FAIL_STATUS: "429" },
    stdio: "ignore",
  });
  const dir = mkdtempSync(join(tmpdir(), "ymr-"));
  const cfgPath = join(dir, "yardmaster.toml");
  writeFileSync(
    cfgPath,
    `schema_version = 1
[providers.f]
kind = "openai_compatible"
base_url = "http://127.0.0.1:19502/v1"
[targets]
[targets.m]
id = "m"
locality = "lan"
provider = "f"
[routes.default]
id = "d"
type = "passthrough"
target = "m"
`,
  );
  const srv = spawn(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      YM_ROUTER_PORT: "19503",
      YM_ROUTER_CONFIG: cfgPath,
      YM_METRICS_DB: join(dir, "m.db"),
      YM_ROUTER_RETRY: "4",
      YM_ROUTER_RETRY_BASE_MS: "50",
    },
    stdio: "ignore",
  });
  t.after(() => {
    flaky.kill();
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  await wait(700);

  const r = await fetch("http://127.0.0.1:19503/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  assert.equal(r.status, 200, "router swallowed the two 429s and got the 200");
  assert.equal(r.headers.get("x-yardmaster-retries"), "2", "two retries recorded");
});
