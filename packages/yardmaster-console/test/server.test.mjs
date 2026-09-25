// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

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

test("server: /api/capabilities proxies the router; reports unavailable when it's unreachable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  writeFileSync(join(dir, "yardmaster.toml"), `schema_version = 1\n[targets]\n`);
  process.env.YM_CONFIG_PATH = join(dir, "yardmaster.toml");
  process.env.YM_CONFIG_FALLBACK = join(dir, "fallback.toml");
  process.env.YM_METRICS_DB = join(dir, "none.db");

  // A stub standing in for the router: records what it was asked, replies
  // with a small fixed registry.
  let lastPath = null;
  let lastMethod = null;
  const stub = createServer((req, res) => {
    lastPath = req.url;
    lastMethod = req.method;
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/capabilities") {
      res.end(JSON.stringify({ records: [{ id: "m1" }], applied: [{ id: "m1" }], pending_ops: [] }));
    } else if (req.url === "/v1/capabilities/apply") {
      res.end(JSON.stringify({ applied: true }));
    } else {
      res.end(JSON.stringify({}));
    }
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  process.env.YM_ROUTER_URL = `http://127.0.0.1:${stub.address().port}`;

  const { createConsoleServer } = await import(`../src/server.mjs?capabilities`);
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    stub.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.YM_ROUTER_URL;
  });

  const caps = await (await fetch(`${base}/api/capabilities`)).json();
  assert.equal(caps.available, true);
  assert.equal(caps.records[0].id, "m1");
  assert.equal(lastPath, "/v1/capabilities");

  const applied = await (await fetch(`${base}/api/capabilities/apply`, { method: "POST" })).json();
  assert.equal(applied.applied, true);
  assert.equal(lastPath, "/v1/capabilities/apply");
  assert.equal(lastMethod, "POST");

  // Unreachable router: /api/capabilities degrades gracefully (200,
  // available:false); the write-through endpoints report 502.
  await new Promise((r) => stub.close(r));
  const down = await (await fetch(`${base}/api/capabilities`)).json();
  assert.equal(down.available, false);
  assert.match(down.note, /router unreachable/);
  const reconcileDown = await fetch(`${base}/api/capabilities/reconcile`, { method: "POST" });
  assert.equal(reconcileDown.status, 502);
});

test("server: /api/capabilities/override upserts [harness.overrides.<id>] and saves through the validate gate", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  const cfgPath = join(dir, "yardmaster.toml");
  writeFileSync(
    cfgPath,
    `schema_version = 1\n[targets]\n[routes.d]\nid="d"\ntype="passthrough"\ntarget="x"\n[targets.x]\nid="qwen/qwen3.8-flash"\n`,
  );
  process.env.YM_CONFIG_PATH = cfgPath;
  process.env.YM_CONFIG_FALLBACK = join(dir, "fallback.toml");
  process.env.YM_METRICS_DB = join(dir, "none.db");

  const { createConsoleServer } = await import(`../src/server.mjs?override`);
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const r1 = await (
    await fetch(`${base}/api/capabilities/override`, {
      method: "POST",
      body: JSON.stringify({ id: "qwen/qwen3.8-flash", patch: { enabled: false } }),
    })
  ).json();
  assert.equal(r1.written, true, JSON.stringify(r1));
  const raw1 = readFileSync(cfgPath, "utf8");
  assert.match(raw1, /\[harness\.overrides\."qwen\/qwen3\.8-flash"\]/);
  assert.match(raw1, /^enabled = false$/m);
  assert.match(raw1, /^\[routes\.d\]/m, "the rest of the file is untouched");

  // A second call updates in place rather than duplicating the table.
  const r2 = await (
    await fetch(`${base}/api/capabilities/override`, {
      method: "POST",
      body: JSON.stringify({ id: "qwen/qwen3.8-flash", patch: { default: true } }),
    })
  ).json();
  assert.equal(r2.written, true, JSON.stringify(r2));
  const raw2 = readFileSync(cfgPath, "utf8");
  assert.equal((raw2.match(/\[harness\.overrides\./g) || []).length, 1, "still exactly one table for this id");
  assert.match(raw2, /^enabled = false$/m);
  assert.match(raw2, /^default = true$/m);

  // A malformed request is rejected before touching the file.
  const bad = await fetch(`${base}/api/capabilities/override`, { method: "POST", body: JSON.stringify({ id: "" }) });
  assert.equal(bad.status, 400);
});

test("server: /api/capabilities/target/set declares [targets.<key>] and saves through the validate gate", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  const cfgPath = join(dir, "yardmaster.toml");
  writeFileSync(
    cfgPath,
    `schema_version = 1\n[egress]\nallow_remote = true\n[providers.openrouter]\nbase_url = "https://openrouter.ai/api/v1"\n[targets]\n`,
  );
  process.env.YM_CONFIG_PATH = cfgPath;
  process.env.YM_CONFIG_FALLBACK = join(dir, "fallback.toml");
  process.env.YM_METRICS_DB = join(dir, "none.db");

  const { createConsoleServer } = await import(`../src/server.mjs?target-set`);
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const r1 = await (
    await fetch(`${base}/api/capabilities/target/set`, {
      method: "POST",
      body: JSON.stringify({ id: "openai/gpt-5.6-terra", provider: "openrouter", locality: "remote" }),
    })
  ).json();
  assert.equal(r1.written, true, JSON.stringify(r1));
  assert.equal(r1.target, "openrouter_openai_gpt_5_6_terra");
  const raw1 = readFileSync(cfgPath, "utf8");
  assert.match(raw1, /\[targets\.openrouter_openai_gpt_5_6_terra\]/);
  assert.match(raw1, /^id = "openai\/gpt-5\.6-terra"$/m);
  assert.match(raw1, /^locality = "remote"$/m);

  // Missing locality is rejected by this endpoint even though validateConfig
  // alone would silently default it to "cluster" — the exact footgun this
  // endpoint exists to close.
  const noLocality = await fetch(`${base}/api/capabilities/target/set`, {
    method: "POST",
    body: JSON.stringify({ id: "another/model", provider: "openrouter" }),
  });
  assert.equal(noLocality.status, 400);
  assert.ok(!readFileSync(cfgPath, "utf8").includes("another/model"), "rejected write never touched the file");

  // An unknown provider is caught by the existing validate gate.
  const badProvider = await (
    await fetch(`${base}/api/capabilities/target/set`, {
      method: "POST",
      body: JSON.stringify({ id: "x/y", provider: "no_such_provider", locality: "remote" }),
    })
  ).json();
  assert.equal(badProvider.written, false);
  assert.ok(badProvider.errors.some((e) => e.includes("no_such_provider")));
});

test("server: /api/capabilities/target/unset removes the [targets.<key>] table and saves through the validate gate", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  const cfgPath = join(dir, "yardmaster.toml");
  writeFileSync(
    cfgPath,
    `schema_version = 1\n[harness.overrides."m/1"]\nenabled = true\n[targets]\n[targets.x]\nid="m/1"\nprovider="p"\nlocality="lan"\n[providers.p]\nbase_url = "http://127.0.0.1:1234/v1"\n`,
  );
  process.env.YM_CONFIG_PATH = cfgPath;
  process.env.YM_CONFIG_FALLBACK = join(dir, "fallback.toml");
  process.env.YM_METRICS_DB = join(dir, "none.db");

  const { createConsoleServer } = await import(`../src/server.mjs?target-unset`);
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const r1 = await (
    await fetch(`${base}/api/capabilities/target/unset`, { method: "POST", body: JSON.stringify({ target: "x" }) })
  ).json();
  assert.equal(r1.written, true, JSON.stringify(r1));
  const raw1 = readFileSync(cfgPath, "utf8");
  assert.ok(!raw1.includes("[targets.x]"), "target table removed");
  assert.match(raw1, /\[harness\.overrides\."m\/1"\]/, "same-id override left in place");

  const missing = await fetch(`${base}/api/capabilities/target/unset`, {
    method: "POST",
    body: JSON.stringify({ target: "nope" }),
  });
  assert.equal(missing.status, 400);
});
