// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("server: healthz, status, validate, config round-trip", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  const cfgPath = join(dir, "yardmaster.toml");
  writeFileSync(cfgPath, `schema_version = 1\n[targets]\n`);
  process.env.YM_CONFIG_PATH = cfgPath;
  process.env.YM_CONFIG_FALLBACK = join(dir, "fallback.toml");
  process.env.YM_METRICS_DB = join(dir, "none.db");
  process.env.YM_AGENT_URL = "http://127.0.0.1:3080";

  const { createConsoleServer } = await import("../src/server.mjs");
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${base}/healthz`)).status, 200);

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.config_path, cfgPath);
  assert.equal(status.metrics_present, false);

  const bad = await (
    await fetch(`${base}/api/config/validate`, { method: "POST", body: `[engines.x]\ntype="openai"\n` })
  ).json();
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("engines")));

  const good = `schema_version = 1\n[targets]\n[routes.d]\nid="d"\ntype="passthrough"\ntarget="x"\n[targets.x]\nid="m"\n`;
  const put = await (await fetch(`${base}/api/config`, { method: "PUT", body: good })).json();
  assert.equal(put.written, true);

  const got = await (await fetch(`${base}/api/config`)).json();
  assert.match(got.raw, /schema_version = 1/);

  const mx = await (await fetch(`${base}/api/metrics?hours=1`)).json();
  assert.equal(mx.available, false);

  const idx = await fetch(`${base}/`);
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /Yardmaster Console/);
});
