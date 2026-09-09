// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0
//
// Dependency-free HTTP + WebSocket reverse proxy with HTTP Basic Auth.
//
// It publishes a loopback-only backend (the DeepSeek Harness `dsh web` binds
// 127.0.0.1 and refuses 0.0.0.0 because it runs model code; the Yardmaster
// inference proxy refuses non-loopback plaintext). Auth is ON by default and
// uses the SAME admin credential the Yardmaster Console sets up on first run
// (a scrypt hash on the /data volume) — so one password covers both web
// surfaces. Until that credential exists the proxy returns 503.
//
// Env:
//   AP_LISTEN_PORT    listen port                          (default 3081)
//   AP_LISTEN_HOST    listen interface                     (default 0.0.0.0)
//   AP_TARGET_HOST    upstream host                        (default 127.0.0.1)
//   AP_TARGET_PORT    upstream port                        (default 3080)
//   AP_AUTH_FILE      shared credential store written by the Console setup
//                     (default /data/Nvidia Corporation/Personal AI Router/console-auth.json)
//   AP_AUTH_USER      username  — env pre-seed, wins over the file
//   AP_AUTH_PASS      password  — env pre-seed, wins over the file
//   AP_REALM          WWW-Authenticate realm               (default "Yardmaster")
//   AP_OPEN           "1"/"true" => no auth, pure pass-through (the LAN
//                     inference bridge uses this; inference clients aren't
//                     browsers and the endpoint has its own model gating)

import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { readFileSync } from "node:fs";
import { scryptSync, timingSafeEqual } from "node:crypto";

const truthy = (v) => v === "1" || v === "true" || v === "yes" || v === "on";
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const cfg = {
  listenPort: num(process.env.AP_LISTEN_PORT, 3081),
  listenHost: process.env.AP_LISTEN_HOST || "0.0.0.0",
  targetHost: process.env.AP_TARGET_HOST || "127.0.0.1",
  targetPort: num(process.env.AP_TARGET_PORT, 3080),
  realm: (process.env.AP_REALM || "Yardmaster").replace(/"/g, ""),
  open: truthy(process.env.AP_OPEN),
  authFile:
    process.env.AP_AUTH_FILE ||
    "/data/Nvidia Corporation/Personal AI Router/console-auth.json",
};

const envUser = process.env.AP_AUTH_USER || "";
const envPass = process.env.AP_AUTH_PASS || "";
const envCreds = envUser && envPass ? { user: envUser, pass: envPass } : null;

function safeEq(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Small cache so a per-request check does not stat/parse on every call, but the
// file (created after this container starts) is still picked up within ~2s.
let fileCache = { at: 0, rec: null };
function loadFileCreds() {
  const now = Date.now();
  if (now - fileCache.at < 2000) return fileCache.rec;
  let rec = null;
  try {
    const j = JSON.parse(readFileSync(cfg.authFile, "utf8"));
    if (j && typeof j.user === "string" && typeof j.salt === "string" && typeof j.hash === "string") rec = j;
  } catch {
    /* not created yet */
  }
  fileCache = { at: now, rec };
  return rec;
}

/** null = no credential configured anywhere yet. */
function haveCredential() {
  return !!envCreds || !!loadFileCreds();
}

function checkBasic(header) {
  const m = /^Basic (.+)$/.exec(String(header || ""));
  if (!m) return false;
  let user = "";
  let pass = "";
  try {
    const s = Buffer.from(m[1], "base64").toString("utf8");
    const i = s.indexOf(":");
    if (i < 0) return false;
    user = s.slice(0, i);
    pass = s.slice(i + 1);
  } catch {
    return false;
  }
  if (envCreds) return safeEq(user, envCreds.user) && safeEq(pass, envCreds.pass);
  const rec = loadFileCreds();
  if (!rec) return false;
  if (!safeEq(user, rec.user)) return false;
  const got = scryptSync(pass, Buffer.from(rec.salt, "hex"), 32);
  return safeEq(got, Buffer.from(rec.hash, "hex"));
}

/** 0 = allowed, 401 = challenge, 503 = not configured yet. */
function gate(req) {
  if (cfg.open) return 0;
  if (!haveCredential()) return 503;
  return checkBasic(req.headers["authorization"]) ? 0 : 401;
}

function reject(res, code) {
  if (code === 503) {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("503 Yardmaster: set an admin username/password in the Yardmaster Console first.\n");
  } else {
    res.writeHead(401, {
      "www-authenticate": `Basic realm="${cfg.realm}", charset="UTF-8"`,
      "content-type": "text/plain",
    });
    res.end("401 Unauthorized\n");
  }
}

const server = createServer((req, res) => {
  const g = gate(req);
  if (g !== 0) return reject(res, g);
  // Forward untouched — keep Host so dsh's browser-trust fence still matches.
  const up = httpRequest(
    { host: cfg.targetHost, port: cfg.targetPort, method: req.method, path: req.url, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`502 upstream error: ${e.message}\n`);
  });
  req.pipe(up);
});

// WebSocket / any Upgrade: authenticate, then splice raw sockets.
server.on("upgrade", (req, client, head) => {
  const g = gate(req);
  if (g !== 0) {
    const line = g === 503 ? "503 Service Unavailable" : "401 Unauthorized";
    const extra = g === 503 ? "" : `WWW-Authenticate: Basic realm="${cfg.realm}"\r\n`;
    client.write(`HTTP/1.1 ${line}\r\n${extra}Connection: close\r\n\r\n`);
    client.destroy();
    return;
  }
  const upstream = netConnect(cfg.targetPort, cfg.targetHost, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const bye = () => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on("error", bye);
  client.on("error", bye);
});

server.listen(cfg.listenPort, cfg.listenHost, () => {
  const mode = cfg.open
    ? "OPEN pass-through"
    : envCreds
      ? `auth via env user "${envUser}"`
      : `auth via ${cfg.authFile} (503 until set)`;
  console.log(
    `yardmaster-auth-proxy: ${cfg.listenHost}:${cfg.listenPort} -> ${cfg.targetHost}:${cfg.targetPort} (${mode})`,
  );
});
