// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Auth is ON by default now; the non-auth functional tests run with it disabled.
process.env.YM_AUTH_DISABLED = "1";

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
  assert.equal(status.auth, "disabled");

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

test("server: /api/agent serves the tokened URL, host derived from the request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  const urlFile = join(dir, "web-url");
  writeFileSync(urlFile, "http://127.0.0.1:3080/?token=SECRET123\n");
  process.env.YM_CONFIG_PATH = join(dir, "yardmaster.toml");
  process.env.YM_HARNESS_URL_FILE = urlFile;
  process.env.YM_AGENT_URL = "http://127.0.0.1:3080";
  process.env.YM_AGENT_PORT = "3080";

  const { createConsoleServer } = await import(`../src/server.mjs?agenturl`);
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // fetch() forbids overriding Host, so use X-Forwarded-Host (which the server
  // prefers anyway — the realistic reverse-proxy case).
  const loopback = await (
    await fetch(`${base}/api/agent`, { headers: { "x-forwarded-host": "127.0.0.1:8770" } })
  ).json();
  assert.equal(loopback.url, "http://127.0.0.1:3080/?token=SECRET123");
  assert.equal(loopback.tokened, true);

  const lan = await (
    await fetch(`${base}/api/agent`, { headers: { "x-forwarded-host": "10.9.8.7:8770" } })
  ).json();
  assert.equal(lan.url, "http://10.9.8.7:3080/?token=SECRET123", "host rewritten to what the browser used");
  assert.equal(lan.base, "http://10.9.8.7:3080");
});

test("server: env credentials (YM_AUTH_USER/PASS) gate everything except /healthz", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  writeFileSync(join(dir, "yardmaster.toml"), `schema_version = 1\n[targets]\n`);
  process.env.YM_CONFIG_PATH = join(dir, "yardmaster.toml");
  process.env.YM_CONFIG_FALLBACK = join(dir, "fallback.toml");
  process.env.YM_METRICS_DB = join(dir, "none.db");
  process.env.YM_AUTH_FILE = join(dir, "console-auth.json");
  delete process.env.YM_AUTH_DISABLED;
  process.env.YM_AUTH_USER = "karl";
  process.env.YM_AUTH_PASS = "s3cret-pw";

  const { createConsoleServer } = await import(`../src/server.mjs?authenv`);
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.YM_AUTH_USER;
    delete process.env.YM_AUTH_PASS;
    delete process.env.YM_AUTH_FILE;
    process.env.YM_AUTH_DISABLED = "1";
  });

  assert.equal((await fetch(`${base}/healthz`)).status, 200, "health probe stays open");

  const noCreds = await fetch(`${base}/api/status`);
  assert.equal(noCreds.status, 401);
  assert.match(noCreds.headers.get("www-authenticate") || "", /Basic realm=/);

  const wrong = await fetch(`${base}/api/status`, {
    headers: { authorization: "Basic " + Buffer.from("karl:nope").toString("base64") },
  });
  assert.equal(wrong.status, 401);

  const ok = await fetch(`${base}/api/status`, {
    headers: { authorization: "Basic " + Buffer.from("karl:s3cret-pw").toString("base64") },
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).auth, "env");
});

test("server: first-run setup flow creates the shared credential", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  writeFileSync(join(dir, "yardmaster.toml"), `schema_version = 1\n[targets]\n`);
  const authFile = join(dir, "console-auth.json");
  process.env.YM_CONFIG_PATH = join(dir, "yardmaster.toml");
  process.env.YM_CONFIG_FALLBACK = join(dir, "fallback.toml");
  process.env.YM_METRICS_DB = join(dir, "none.db");
  process.env.YM_AUTH_FILE = authFile;
  delete process.env.YM_AUTH_DISABLED;

  const { createConsoleServer } = await import(`../src/server.mjs?setup`);
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.YM_AUTH_FILE;
    process.env.YM_AUTH_DISABLED = "1";
  });

  // Unconfigured: any page -> the setup form, API -> 403 setup.
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /first-run setup/i);
  assert.equal((await fetch(`${base}/api/status`)).status, 403);

  // Bad inputs.
  assert.equal(
    (await fetch(`${base}/api/setup`, { method: "POST", body: JSON.stringify({ user: "a", password: "short" }) })).status,
    400,
  );

  // Create it.
  const setup = await fetch(`${base}/api/setup`, {
    method: "POST",
    body: JSON.stringify({ user: "admin", password: "correct horse" }),
  });
  assert.equal(setup.status, 200);
  assert.ok(existsSync(authFile));
  const rec = JSON.parse(readFileSync(authFile, "utf8"));
  assert.equal(rec.user, "admin");
  assert.ok(rec.salt && rec.hash);
  assert.ok(!/correct horse/.test(readFileSync(authFile, "utf8")), "password is not stored in cleartext");

  // Now it's configured: 401 without creds, 200 with, setup re-run is 409.
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const ok = await fetch(`${base}/api/status`, {
    headers: { authorization: "Basic " + Buffer.from("admin:correct horse").toString("base64") },
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).auth, "configured");
  // Re-running setup once configured: unauthenticated -> 401, authenticated -> 409.
  assert.equal(
    (await fetch(`${base}/api/setup`, { method: "POST", body: JSON.stringify({ user: "x", password: "xxxxxxxx" }) }))
      .status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/setup`, {
        method: "POST",
        headers: { authorization: "Basic " + Buffer.from("admin:correct horse").toString("base64") },
        body: JSON.stringify({ user: "x", password: "xxxxxxxx" }),
      })
    ).status,
    409,
  );
});

test("server: PUT replaces a dangling symlink at the config path", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  const cfgPath = join(dir, "yardmaster.toml");
  symlinkSync("/does/not/exist/config.toml", cfgPath); // stale :ro-mount leftover
  assert.equal(existsSync(cfgPath), false);
  assert.equal(lstatSync(cfgPath).isSymbolicLink(), true);

  process.env.YM_CONFIG_PATH = cfgPath;
  process.env.YM_CONFIG_FALLBACK = join(dir, "fallback.toml");
  process.env.YM_METRICS_DB = join(dir, "none.db");
  const { createConsoleServer } = await import(`../src/server.mjs?danglingsymlink`);
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const body = `schema_version = 1\n[targets]\n[routes.d]\nid="d"\ntype="passthrough"\ntarget="x"\n[targets.x]\nid="m"\n`;
  const r = await (await fetch(`${base}/api/config`, { method: "PUT", body })).json();
  assert.equal(r.written, true, JSON.stringify(r));
  assert.equal(lstatSync(cfgPath).isSymbolicLink(), false, "symlink replaced by a real file");
});
