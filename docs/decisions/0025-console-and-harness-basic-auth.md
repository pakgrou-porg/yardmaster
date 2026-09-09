<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 25. Opt-in HTTP Basic Auth for the Console and the Harness

- Status: accepted
- Date: 2026-09-09
- Deciders: @pakgrou-porg

## Context

[ADR-0022](0022-headless-container-deployment.md) and
[ADR-0023](0023-yardmaster-console.md) ship two loopback-first web surfaces:

- the **Yardmaster Console** (`:8770`) — edits `yardmaster.toml`, lists backends;
- the **DeepSeek Harness** `dsh web` (`:3080`) — runs model-generated code,
  guarded upstream only by a per-boot launch token + a signed cookie.

Both are published through the namespace owner and gated by
`${YM_BIND:-127.0.0.1}`. Operators asked to reach them from anywhere on the LAN
(`YM_BIND=0.0.0.0`), which removes the only thing protecting the Console and
downgrades the Harness to "anyone with the tokened URL". `dsh`'s
`dsh-host-webserver` has no auth knob, and `dsh web` deliberately refuses
`--host 0.0.0.0`.

A full reverse proxy (Caddy/Traefik + TLS + SSO) is the right answer for a
shared or hostile network, but it is disproportionate for the common case — a
single-operator box on a home LAN who just wants a username and password that
survives `docker restart`.

## Decision

Add **opt-in HTTP Basic Auth**, one toggle covering both surfaces, credentials
from the environment (so they live in the Portainer stack / `.env` and are
durable across restarts and reboots):

| Var | Meaning |
| --- | --- |
| `YM_AUTH_ENABLED` | `1`/`true` to require auth (default off) |
| `YM_AUTH_USER` | username |
| `YM_AUTH_PASS` | password |
| `YM_AUTH_PASS_FILE` | read the password from a file (Docker secret); wins over `YM_AUTH_PASS` |
| `YM_AUTH_REALM` | `WWW-Authenticate` realm (cosmetic) |

- **Console**: enforced natively in `packages/yardmaster-console/src/server.mjs`
  (constant-time compare via `crypto.timingSafeEqual`). `/healthz` stays open so
  container health probes keep working. Reports `auth_enabled` in `/api/status`.
- **Harness**: a new dependency-free Node HTTP + WebSocket reverse proxy
  (`docker/auth-proxy.mjs`, shipped in the image at
  `/opt/yardmaster/lib/yardmaster-auth-proxy.mjs`) **replaces the `socat` shim**
  as `yardmaster-harness-proxy`. It forwards `3081 → 127.0.0.1:3080`, preserves
  the `Host` header (so dsh's browser-trust fence still matches `YM_LAN_HOST`),
  proxies the dsh client's WebSocket upgrade, and applies the same Basic Auth.
  Driven by `AP_AUTH_ENABLED` / `AP_AUTH_USER` / `AP_AUTH_PASS`, which the stacks
  wire from the `YM_AUTH_*` values.
- **Fail closed on misconfig**: with auth enabled but user or pass empty, both
  the Console and the proxy **exit non-zero at startup** rather than run open.
- Basic Auth is *in addition to* dsh's launch-token + cookie, not a replacement.

`socat` is dropped from the Harness path (the Node proxy is a superset); the
`yardmaster-lan-shim` on the inference proxy is unchanged — that path has its own
model and PAIR's mTLS story.

## Consequences

- One extra tiny Node process per node (`yardmaster-harness-proxy`), from the
  image already in use — no new image to pull.
- Basic Auth is cleartext-over-HTTP: on an untrusted network still use a real
  TLS-terminating proxy. Documented in `docs/deployment-docker.md` and
  `docs/deployment-framework-strix-halo.md` §6.
- The old `yardmaster-harness-shim` service name changes to
  `yardmaster-harness-proxy`; redeploys must remove the old container.
- Credentials sit in the stack definition / `.env`. `YM_AUTH_PASS_FILE` +
  Docker/Portainer secrets is the hardening path.
