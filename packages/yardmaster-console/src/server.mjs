// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * The Yardmaster Console: one loopback web UI to configure and observe
 * Yardmaster and to reach the DeepSeek Harness Web UI, before a full console is
 * deployed over it.
 *
 * Endpoints:
 *   GET  /healthz
 *   GET  /api/status                 runtime + which features are live
 *   GET  /api/config                 { raw, path, writable }
 *   POST /api/config/validate        body: raw toml  -> { ok, errors, warnings }
 *   PUT  /api/config                 body: raw toml  -> validate then write
 *   GET  /api/backends               probe every provider/target + local engine
 *   GET  /api/metrics?hours=24       read-only view of yardmaster-metrics.db
 *   GET  /api/agent                  { url } for the embedded dsh Web UI
 *   GET  /  (and static assets)      the SPA
 *
 * Binds 127.0.0.1 by default. Set YM_CONSOLE_BIND=0.0.0.0 to serve the LAN; when
 * you do, enable HTTP Basic Auth with YM_AUTH_ENABLED=1 + YM_AUTH_USER +
 * YM_AUTH_PASS (or YM_AUTH_PASS_FILE). /healthz stays open for health probes.
 */

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, access, lstat, unlink } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { timingSafeEqual, scryptSync, randomBytes } from "node:crypto";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { validateConfig } from "./validate.mjs";
import { probeBackends } from "./backends.mjs";
import { readMetrics } from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");

const cfg = {
  port: Number(process.env.YM_CONSOLE_PORT || 8770),
  bind: process.env.YM_CONSOLE_BIND || "127.0.0.1",
  configPath: process.env.YM_CONFIG_PATH || "/config/yardmaster.toml",
  fallbackConfigPath:
    process.env.YM_CONFIG_FALLBACK ||
    "/data/Nvidia Corporation/Personal AI Router/yardmaster.toml",
  metricsDb:
    process.env.YM_METRICS_DB ||
    "/data/Nvidia Corporation/Personal AI Router/yardmaster-metrics.db",
  agentUrl: process.env.YM_AGENT_URL || "http://127.0.0.1:3080",
  // The harness entrypoint writes the current tokened URL here.
  harnessUrlFile: process.env.YM_HARNESS_URL_FILE || "/dshhome/web-url",
  localEngineUrl: process.env.YM_LOCAL_ENGINE_URL || "",
  dataplaneBin: process.env.YM_DATAPLANE_BIN || "", // e.g. /opt/yardmaster/bin/yardmaster-dataplane
  // Shared admin credential store — the Harness auth proxy reads the same file.
  authFile:
    process.env.YM_AUTH_FILE ||
    "/data/Nvidia Corporation/Personal AI Router/console-auth.json",
  authRealm: (process.env.YM_AUTH_REALM || "Yardmaster").replace(/"/g, ""),
};

/**
 * Authentication. ON by default: with no credential configured the Console
 * serves a one-time setup page and refuses everything else until an admin
 * picks a username + password (persisted to cfg.authFile on the /data volume,
 * so it survives restarts). YM_AUTH_USER + YM_AUTH_PASS pre-seed it from the
 * environment; YM_AUTH_DISABLED=1 turns auth off entirely (loopback dev only).
 */
const truthy = (v) => v === "1" || v === "true" || v === "yes" || v === "on";
const AUTH_DISABLED = truthy(process.env.YM_AUTH_DISABLED);
const envUser = process.env.YM_AUTH_USER || "";
let envPass = process.env.YM_AUTH_PASS || "";
if (process.env.YM_AUTH_PASS_FILE) {
  try {
    envPass = readFileSync(process.env.YM_AUTH_PASS_FILE, "utf8").replace(/\r?\n$/, "");
  } catch (e) {
    throw new Error(`YM_AUTH_PASS_FILE unreadable: ${e.message}`);
  }
}
const envCreds = envUser && envPass ? { user: envUser, pass: envPass } : null;

const safeEq = (a, b) => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

function readAuthFile() {
  try {
    const j = JSON.parse(readFileSync(cfg.authFile, "utf8"));
    if (j && typeof j.user === "string" && typeof j.salt === "string" && typeof j.hash === "string") return j;
  } catch {
    /* not set up yet */
  }
  return null;
}
function writeAuthFile(user, password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  mkdirSync(dirname(cfg.authFile), { recursive: true });
  writeFileSync(
    cfg.authFile,
    JSON.stringify({ v: 1, user, salt: salt.toString("hex"), hash: hash.toString("hex"), created: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
}
/** "disabled" | "env" | "configured" | "setup" */
function authState() {
  if (AUTH_DISABLED) return "disabled";
  if (envCreds) return "env";
  return readAuthFile() ? "configured" : "setup";
}
function checkBasic(header) {
  const m = /^Basic (.+)$/.exec(String(header || ""));
  if (!m) return false;
  const s = Buffer.from(m[1], "base64").toString("utf8");
  const i = s.indexOf(":");
  if (i < 0) return false;
  const user = s.slice(0, i);
  const pass = s.slice(i + 1);
  if (envCreds) return safeEq(user, envCreds.user) && safeEq(pass, envCreds.pass);
  const rec = readAuthFile();
  if (!rec || !safeEq(user, rec.user)) return false;
  return safeEq(scryptSync(pass, Buffer.from(rec.salt, "hex"), 32), Buffer.from(rec.hash, "hex"));
}
function challenge(res) {
  res.writeHead(401, {
    "www-authenticate": `Basic realm="${cfg.authRealm}", charset="UTF-8"`,
    "content-type": "text/plain",
  });
  res.end("401 Unauthorized\n");
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const json = (res, code, obj) => {
  const b = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
};
const readBody = (req) =>
  new Promise((resolve) => {
    const c = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
  });

/** Can we create/overwrite `p`? Checks the file if it exists, else its parent dir. */
async function canWrite(p) {
  try {
    await access(p, FS.W_OK);
    return true;
  } catch {
    /* file missing or read-only — check the directory */
  }
  try {
    await mkdir(dirname(p), { recursive: true });
    await access(dirname(p), FS.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where we can actually write: the primary path if writable, else the fallback. */
async function writablePath() {
  if (await canWrite(cfg.configPath)) return cfg.configPath;
  if (await canWrite(cfg.fallbackConfigPath)) return cfg.fallbackConfigPath;
  return null;
}

async function loadConfig() {
  for (const p of [cfg.configPath, cfg.fallbackConfigPath]) {
    if (existsSync(p)) return { raw: await readFile(p, "utf8"), path: p };
  }
  return { raw: "", path: cfg.configPath };
}

/** Prefer the real dry-run when the binary is present; else the JS validator. */
function validateWithDataplane(raw) {
  return new Promise((resolve) => {
    if (!cfg.dataplaneBin || !existsSync(cfg.dataplaneBin)) return resolve(null);
    const tmp = join(process.env.RUNNER_TEMP || "/tmp", `ym-validate-${Date.now()}.toml`);
    writeFile(tmp, raw)
      .then(() =>
        execFile(cfg.dataplaneBin, ["dry-run", "--config", tmp], { timeout: 10_000 }, (err, _out, stderr) => {
          resolve({
            ok: !err,
            errors: err ? [String(stderr || err.message).trim()] : [],
            warnings: [],
            engine: "yardmaster-dataplane dry-run",
          });
        }),
      )
      .catch(() => resolve(null));
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });

  // First-run setup: create the admin credential. Allowed only while unconfigured.
  if (url.pathname === "/api/setup" && req.method === "POST") {
    if (authState() !== "setup") return json(res, 409, { ok: false, error: "already configured" });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { ok: false, error: "invalid JSON" });
    }
    const user = String(body.user || "").trim();
    const password = String(body.password || "");
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(user)) {
      return json(res, 400, { ok: false, error: "username must be 2-64 chars: letters, digits, . _ -" });
    }
    if (password.length < 8) return json(res, 400, { ok: false, error: "password must be at least 8 characters" });
    try {
      writeAuthFile(user, password);
    } catch (e) {
      return json(res, 500, { ok: false, error: `could not write ${cfg.authFile}: ${e.message}` });
    }
    return json(res, 200, { ok: true });
  }

  // Change the password (must already be authenticated to reach here).
  if (url.pathname === "/api/auth/password" && req.method === "POST") {
    if (authState() === "env") {
      return json(res, 409, { ok: false, error: "credentials come from YM_AUTH_USER/PASS env — change them there" });
    }
    if (authState() === "disabled") return json(res, 409, { ok: false, error: "auth is disabled" });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { ok: false, error: "invalid JSON" });
    }
    const password = String(body.password || "");
    if (password.length < 8) return json(res, 400, { ok: false, error: "password must be at least 8 characters" });
    const rec = readAuthFile();
    try {
      writeAuthFile(rec.user, password);
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/status") {
    return json(res, 200, {
      version: "0.1.0-console",
      config_path: cfg.configPath,
      metrics_db: cfg.metricsDb,
      metrics_present: existsSync(cfg.metricsDb),
      auth: authState(),
      agent_url: cfg.agentUrl,
      local_engine_url: cfg.localEngineUrl || null,
      dataplane_dry_run: !!(cfg.dataplaneBin && existsSync(cfg.dataplaneBin)),
      note:
        "Config editing + backend probing work now. Routing/metrics fill in once " +
        "YM_DATAPLANE_MODE=dataplane exists (repo issues #36/#26).",
    });
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    const { raw, path } = await loadConfig();
    return json(res, 200, { raw, path, writable_path: await writablePath() });
  }

  if (url.pathname === "/api/config/validate" && req.method === "POST") {
    const raw = await readBody(req);
    const dp = await validateWithDataplane(raw);
    return json(res, 200, dp || { ...validateConfig(raw), engine: "console js validator" });
  }

  if (url.pathname === "/api/config" && req.method === "PUT") {
    const raw = await readBody(req);
    const dp = await validateWithDataplane(raw);
    const v = dp || validateConfig(raw);
    if (!v.ok) return json(res, 400, { written: false, ...v });
    const target = await writablePath();
    if (!target) {
      return json(res, 500, {
        written: false,
        errors: [
          `neither ${cfg.configPath} nor ${cfg.fallbackConfigPath} is writable — ` +
            `check the /data volume ownership (the console runs as uid 10001; run yardmaster-init)`,
        ],
        warnings: v.warnings,
      });
    }
    try {
      // A dangling symlink at the config path (e.g. a removed read-only /config
      // bind mount) makes writeFile ENOENT — replace it with a real file.
      try {
        const st = await lstat(target);
        if (st.isSymbolicLink() && !existsSync(target)) await unlink(target);
      } catch {
        /* nothing there — fine */
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, raw, "utf8");
    } catch (e) {
      return json(res, 500, { written: false, errors: [`write failed: ${e.message}`], warnings: v.warnings });
    }
    return json(res, 200, { written: true, path: target, ...v });
  }

  if (url.pathname === "/api/backends" && req.method === "GET") {
    const { raw } = await loadConfig();
    const backends = await probeBackends(raw, { localEngineUrl: cfg.localEngineUrl });
    return json(res, 200, { backends });
  }

  if (url.pathname === "/api/metrics" && req.method === "GET") {
    const hours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("hours") || 24)));
    return json(res, 200, readMetrics(cfg.metricsDb, { hours }));
  }

  if (url.pathname === "/api/agent" && req.method === "GET") {
    // The agent is on the same host the browser used to reach the Console,
    // port YM_AGENT_PORT (default 3080) — so a LAN browser gets a LAN URL and a
    // loopback browser gets a loopback URL.
    const browserHost = (req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1:8770")
      .toString()
      .split(":")[0];
    const agentPort = process.env.YM_AGENT_PORT || "3080";
    const base = `http://${browserHost}:${agentPort}`;
    // Prefer the current tokened URL the harness wrote; rewrite its authority.
    let tokenedUrl = null;
    try {
      const u = (await readFile(cfg.harnessUrlFile, "utf8")).trim();
      if (/^https?:\/\//.test(u)) {
        try {
          const t = new URL(u);
          const b = new URL(base);
          t.protocol = b.protocol;
          t.host = b.host;
          tokenedUrl = t.toString();
        } catch {
          tokenedUrl = u;
        }
      }
    } catch {
      /* no web-url file yet — harness not up, or older image */
    }
    return json(res, 200, { url: tokenedUrl || base, base, tokened: !!tokenedUrl });
  }

  return json(res, 404, { error: "not found" });
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(body);
}

/**
 * Gate a request. Returns:
 *   "ok"     — allowed through
 *   "setup"  — unconfigured; caller should serve the setup page / allow /api/setup
 * and otherwise writes a 401 challenge itself and returns "handled".
 */
function gate(req, res, url) {
  const p = url.pathname;
  if (p === "/healthz") return "ok"; // health probes: always open
  const state = authState();
  if (state === "disabled") return "ok";
  if (state === "setup") {
    if (p === "/api/setup") return "ok"; // create the credential
    return "setup"; // everything else: show the setup form, refuse the rest
  }
  // "configured" | "env": require Basic Auth
  if (checkBasic(req.headers["authorization"])) return "ok";
  challenge(res);
  return "handled";
}

export function createConsoleServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "console"}`);
      const g = gate(req, res, url);
      if (g === "handled") return;
      if (g === "setup") {
        if (url.pathname.startsWith("/api/")) return json(res, 403, { error: "setup required", setup: true });
        return serveStatic(res, "/setup.html"); // any page -> the setup form
      }
      if (url.pathname === "/healthz" || url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(res, url.pathname);
      }
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
}

// Started directly (not imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  createConsoleServer().listen(cfg.port, cfg.bind, () => {
    console.log(`yardmaster-console on http://${cfg.bind}:${cfg.port}  (config: ${cfg.configPath})`);
  });
}
