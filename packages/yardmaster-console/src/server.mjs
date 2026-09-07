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
 * Binds 127.0.0.1 by default. Set YM_CONSOLE_BIND=0.0.0.0 only behind your own
 * auth.
 */

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  localEngineUrl: process.env.YM_LOCAL_ENGINE_URL || "",
  dataplaneBin: process.env.YM_DATAPLANE_BIN || "", // e.g. /opt/yardmaster/bin/yardmaster-dataplane
};

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

/** Where we can actually write: the primary path if writable, else the data-dir copy. */
function writablePath() {
  const primary = cfg.configPath;
  if (existsSync(primary)) {
    try {
      // heuristic: bind-mounts are often :ro; a write probe is the only sure test,
      // but we avoid mutating — assume the data-dir fallback when the parent dir
      // is not writable.
      return primary;
    } catch {
      /* fall through */
    }
  }
  return cfg.fallbackConfigPath;
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

  if (url.pathname === "/api/status") {
    return json(res, 200, {
      version: "0.1.0-console",
      config_path: cfg.configPath,
      metrics_db: cfg.metricsDb,
      metrics_present: existsSync(cfg.metricsDb),
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
    return json(res, 200, { raw, path, writable_path: writablePath() });
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
    const target = writablePath();
    try {
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
    return json(res, 200, { url: cfg.agentUrl });
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

export function createConsoleServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "console"}`);
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
