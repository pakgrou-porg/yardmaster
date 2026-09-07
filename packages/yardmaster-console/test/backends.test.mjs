// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeBackends } from "../src/backends.mjs";

const STUB = fileURLToPath(new URL("../../../tests/integration/stub-engine/server.mjs", import.meta.url));

function startStub(port, models) {
  const p = spawn(process.execPath, [STUB], {
    env: { ...process.env, NODE_NAME: `stub-${port}`, PORT: String(port), MODELS: models },
    stdio: "ignore",
  });
  return p;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("probes providers from config + the local engine URL", async (t) => {
  const a = startStub(18091, "qwen4:12b,qwen4:72b");
  const b = startStub(18092, "gemma-4-12b-utility");
  t.after(() => {
    a.kill();
    b.kill();
  });
  await wait(400);

  const raw = `
schema_version = 1
[targets]
[providers.local]
kind = "openai_compatible"
base_url = "http://127.0.0.1:18091/v1"
[providers.asus]
kind = "openai_compatible"
base_url = "http://127.0.0.1:18092/v1"
`;
  const res = await probeBackends(raw, { localEngineUrl: "http://127.0.0.1:18091", timeoutMs: 1500 });

  const asus = res.find((r) => r.name === "asus");
  assert.equal(asus.up, true);
  assert.ok(asus.models.includes("gemma-4-12b-utility"));
  assert.ok(asus.latency_ms >= 0);

  // local engine URL dedupes against the `local` provider (same base) — one entry.
  assert.equal(res.filter((r) => r.base_url.includes("18091")).length, 1);

  const dead = await probeBackends(
    `schema_version=1\n[targets]\n[providers.gone]\nkind="openai_compatible"\nbase_url="http://127.0.0.1:1/v1"\n`,
    { timeoutMs: 500 },
  );
  assert.equal(dead[0].up, false);
  assert.ok(dead[0].error);
});

test("an unparseable config still probes the local engine", async (t) => {
  const s = startStub(18093, "m1");
  t.after(() => s.kill());
  await wait(400);
  const res = await probeBackends("this is not toml = = =", { localEngineUrl: "http://127.0.0.1:18093", timeoutMs: 1500 });
  assert.equal(res.length, 1);
  assert.equal(res[0].up, true);
});
