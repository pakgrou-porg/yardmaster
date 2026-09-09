// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0
//
// Dependency-free HTTP + WebSocket reverse proxy with optional HTTP Basic Auth.
//
// It publishes a loopback-only backend (the DeepSeek Harness `dsh web` binds
// 127.0.0.1 and refuses 0.0.0.0 because it runs model code) and, when the admin
// turns it on, gates that backend behind a username + password. With auth off it
// is a transparent pass-through — the same job the `socat` shim did.
//
// Credentials come from the environment (durable: they live in the Portainer
// stack / .env), so they survive restarts and reboots.
//
// Env:
//   AP_LISTEN_PORT      listen port                       (default 3081)
//   AP_LISTEN_HOST      listen interface                  (default 0.0.0.0)
//   AP_TARGET_HOST      upstream host                     (default 127.0.0.1)
//   AP_TARGET_PORT      upstream port                     (default 3080)
//   AP_AUTH_ENABLED     "1"/"true" to require Basic Auth  (default off)
//   AP_AUTH_USER        username
//   AP_AUTH_PASS        password
//   AP_AUTH_PASS_FILE   read the password from this file (Docker secret); wins over AP_AUTH_PASS
//   AP_REALM            WWW-Authenticate realm            (default "Yardmaster")

import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const truthy = (v) => v === "1" || v === "true" || v === "yes" || v === "on";
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const cfg = {
  listenPort: num(process.env.AP_LISTEN_PORT, 3081),
  listenHost: process.env.AP_LISTEN_HOST || "0.0.0.0",
  targetHost: process.env.AP_TARGET_HOST || "127.0.0.1",
  targetPort: num(process.env.AP_TARGET_PORT, 3080),
  realm: (process.env.AP_REALM || "Yardmaster").replace(/"/g, ""),
};

let pass = process.env.AP_AUTH_PASS || "";
if (process.env.AP_AUTH_PASS_FILE) {
  try {
    pass = readFileSync(process.env.AP_AUTH_PASS_FILE, "utf8").replace(/\r?\n$/, "");
  } catch (e) {
    console.error(`yardmaster-auth-proxy: cannot read AP_AUTH_PASS_FILE: ${e.message}`);
    process.exit(1);
  }
}
const user = process.env.AP_AUTH_USER || "";
const authOn = truthy(process.env.AP_AUTH_ENABLED);

if (authOn && (user === "" || pass === "")) {
  console.error(
    "yardmaster-auth-proxy: AP_AUTH_ENABLED is set but AP_AUTH_USER / AP_AUTH_PASS are empty — refusing to start open.",
  );
  process.exit(1);
}
const expected = Buffer.from("Basic " + Buffer.from(`${user}:${pass}`).toString("base64"));

function ok(req) {
  if (!authOn) return true;
  const got = Buffer.from(String(req.headers["authorization"] || ""));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const server = createServer((req, res) => {
  if (!ok(req)) {
    res.writeHead(401, {
      "www-authenticate": `Basic realm="${cfg.realm}", charset="UTF-8"`,
      "content-type": "text/plain",
    });
    res.end("401 Unauthorized\n");
    return;
  }
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
  if (!ok(req)) {
    client.write(
      `HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${cfg.realm}"\r\nConnection: close\r\n\r\n`,
    );
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
  console.log(
    `yardmaster-auth-proxy: ${cfg.listenHost}:${cfg.listenPort} -> ${cfg.targetHost}:${cfg.targetPort} ` +
      `(auth ${authOn ? `ON, user "${user}"` : "off — pass-through"})`,
  );
});
