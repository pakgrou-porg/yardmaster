<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 26. Three-container stack, bundled Console, first-run admin credential

- Status: accepted
- Date: 2026-09-09
- Deciders: @pakgrou-porg
- Supersedes parts of [ADR-0023](0023-yardmaster-console.md),
  [ADR-0024](0024-container-sibling-engine-wiring.md),
  [ADR-0025](0025-console-and-harness-basic-auth.md)

## Context

The deployed stack had grown to eight containers (`ollama`, `yardmaster-init`,
`yardmaster`, `yardmaster-lan-shim`, `yardmaster-harness`,
`yardmaster-harness-proxy`, `yardmaster-console`, plus a stale
`yardmaster-harness-shim` from an earlier revision) and several manual steps
(chown the volumes, hand-write `cordis.patch.yml` to point `dsh` at Yardmaster,
choose an auth toggle). ADR-0025's Basic Auth was opt-in and env-only; the
operator wanted it **on by default**, admin-configured.

## Decision

### Topology — three containers

| Container | Runs |
| --- | --- |
| `ollama` | the engine; owns the netns; declares every published port |
| `yardmaster` | `nvpair-ui-broker` + PAIR proxy **+ the Yardmaster Console (bundled) + a LAN bridge** for the proxy's loopback-only ingress |
| `yardmaster-harness` | `dsh web` **+ its Basic-Auth reverse proxy**, auto-configured for Yardmaster |

The Console is built into the `yardmaster` image (a `console-build` stage → one
node runtime shared with `dsh`). The `socat` shims are replaced by
`docker/auth-proxy.mjs` run in two modes: `AP_OPEN=1` as the inference LAN
bridge inside `yardmaster`, and auth-enforcing in front of `dsh`.

`yardmaster-init` is gone: each entrypoint starts as root (`user: "0:0"` in the
stack), `chown`s its named volume, then `exec gosu 10001` to drop privileges.
Each container supervises its children and exits if any dies, so Docker restarts
the whole unit.

### Harness auto-configuration

The harness entrypoint writes `$DSH_HOME/profiles/web/cordis.patch.yml` (marked
`# managed by yardmaster-harness-entrypoint` on line 1) configuring
`@deepseek-ai/dsh-llm-pi-ai` with a `yardmaster` provider route
(`baseURL: http://127.0.0.1:11435/v1`, `api: openai-completions`) and
`agent-default-model` = that route + `YM_HARNESS_MODEL` (default
`llama3.2:latest`). A file **without** the marker on line 1 is treated as
operator-authored and left untouched.

### Auth — on by default, one shared admin credential

- One credential covers the Console and the Harness. Stored as a scrypt hash at
  `/data/Nvidia Corporation/Personal AI Router/console-auth.json` on the data
  volume (survives restarts). The Harness auth proxy mounts `/data` read-only
  and verifies against the same file.
- **First run**: with no credential (no `YM_AUTH_USER`/`YM_AUTH_PASS` env, no
  file) the Console serves a setup page and refuses everything else; the Harness
  proxy returns `503` until the file exists.
- `YM_AUTH_USER` + `YM_AUTH_PASS` (or `YM_AUTH_PASS_FILE`) pre-seed it from the
  environment. `YM_AUTH_DISABLED=1` turns auth off entirely (documented
  loopback-dev escape hatch). `/healthz` is always open.
- The operator does first-run setup from the host (`YM_BIND=127.0.0.1`), then
  sets `YM_BIND=0.0.0.0` and redeploys to expose the ports.

### OpenRouter in `yardmaster.toml`

`deploy/portainer/yardmaster.toml.example` now ships a
`[providers.openrouter]` (`kind = "openrouter"`, `api_key_env =
"OPENROUTER_API_KEY"`) with six `locality = "remote"` model targets, alongside
keyless local Ollama and LAN vLLM providers. `[egress] allow_remote = true` is
required for those targets to load; default routing is still
`[routes.default] -> local`, so cloud models are reached only when a request
names their slug.

## Consequences

- 8 → 3 containers; no init container; no hand-written dsh config; no auth
  toggle to forget.
- `YM_AUTH_ENABLED` (ADR-0025) is removed. Auth is the default; the escape hatch
  is `YM_AUTH_DISABLED`.
- The `yardmaster` container is multi-process (broker + console + bridge) under a
  shell supervisor + `tini`. Logs interleave; a crash of any one restarts the
  container. Accepted for a single-node appliance.
- `dsh` still runs its own launch-token + signed cookie underneath the shared
  Basic Auth.
- Basic Auth is cleartext over HTTP — for a hostile network, terminate TLS / add
  SSO with a real reverse proxy and keep `YM_BIND=127.0.0.1`.
