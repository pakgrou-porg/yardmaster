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

test("server: /api/capabilities/policy upserts [harness.policy] and saves through the validate gate", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  const cfgPath = join(dir, "yardmaster.toml");
  writeFileSync(cfgPath, `schema_version = 1\n[targets]\n[harness.policy]\nsmoke_test = true\n`);
  process.env.YM_CONFIG_PATH = cfgPath;
  process.env.YM_CONFIG_FALLBACK = join(dir, "fallback.toml");
  process.env.YM_METRICS_DB = join(dir, "none.db");

  const { createConsoleServer } = await import(`../src/server.mjs?policy`);
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const r1 = await (
    await fetch(`${base}/api/capabilities/policy`, {
      method: "POST",
      body: JSON.stringify({ patch: { require_approval: true } }),
    })
  ).json();
  assert.equal(r1.written, true, JSON.stringify(r1));
  const raw1 = readFileSync(cfgPath, "utf8");
  assert.match(raw1, /^\[harness\.policy\]$/m);
  assert.match(raw1, /^require_approval = true$/m);
  assert.match(raw1, /^smoke_test = true$/m, "unpatched policy key untouched");

  const badBody = await fetch(`${base}/api/capabilities/policy`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(badBody.status, 400);

  const badType = await (
    await fetch(`${base}/api/capabilities/policy`, {
      method: "POST",
      body: JSON.stringify({ patch: { require_approval: "yes" } }),
    })
  ).json();
  assert.equal(badType.written, false, "the validate gate rejects a bad type before it can land on disk");
});

test("server: /api/capabilities/approve-live grandfathers the currently-applied set in one write", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymc-"));
  const cfgPath = join(dir, "yardmaster.toml");
  writeFileSync(
    cfgPath,
    `schema_version = 1\n[targets]\n[targets.a]\nid="a/model"\n[targets.b]\nid="b/model"\n[targets.c]\nid="c/model"\n`,
  );
  process.env.YM_CONFIG_PATH = cfgPath;
  process.env.YM_CONFIG_FALLBACK = join(dir, "fallback.toml");
  process.env.YM_METRICS_DB = join(dir, "none.db");

  // A real router would reflect the override back on its next reconcile;
  // this stub approximates that by reading the same file the Console just
  // wrote, so the "nothing left to grandfather" second call is a real check
  // rather than a static fixture.
  const stub = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/capabilities") {
      const raw = readFileSync(cfgPath, "utf8");
      const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const approvalFor = (id) => (new RegExp(`\\[harness\\.overrides\\."${escapeRegExp(id)}"\\]\\napproved = true`).test(raw) ? "approved" : "pending");
      res.end(
        JSON.stringify({
          applied: [{ id: "a/model" }, { id: "b/model" }],
          records: [
            { id: "a/model", approval: approvalFor("a/model") }, // live, never opined -> grandfather
            { id: "b/model", approval: approvalFor("b/model") }, // live, never opined -> grandfather
            { id: "c/model", approval: "pending" }, // pending but NOT live -> leave alone
          ],
          pending_ops: [],
        }),
      );
    } else {
      res.end(JSON.stringify({}));
    }
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  process.env.YM_ROUTER_URL = `http://127.0.0.1:${stub.address().port}`;

  const { createConsoleServer } = await import(`../src/server.mjs?approve-live`);
  const srv = createConsoleServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => {
    srv.close();
    stub.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.YM_ROUTER_URL;
  });

  const r = await (await fetch(`${base}/api/capabilities/approve-live`, { method: "POST" })).json();
  assert.equal(r.written, true, JSON.stringify(r));
  assert.deepEqual(r.approved.sort(), ["a/model", "b/model"]);
  const raw = readFileSync(cfgPath, "utf8");
  assert.match(raw, /\[harness\.overrides\."a\/model"\]\napproved = true/);
  assert.match(raw, /\[harness\.overrides\."b\/model"\]\napproved = true/);
  assert.doesNotMatch(raw, /\[harness\.overrides\."c\/model"\]/, "not in the applied set — no override written for it");

  // Nothing left to grandfather on a second call.
  const r2 = await (await fetch(`${base}/api/capabilities/approve-live`, { method: "POST" })).json();
  assert.equal(r2.written, false);
  assert.deepEqual(r2.approved, []);
});
