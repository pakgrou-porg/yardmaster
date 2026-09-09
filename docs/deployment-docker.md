<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Deploying Yardmaster with Docker and Portainer

Yardmaster's first-class shape is the PAIR **desktop app**. This page covers the
**headless container** path — the `nvpair-ui-broker` control plane plus every Go
worker (and, when it builds, the Rust data plane) with no Electron — plus the
**Yardmaster Console** (ADR-0023) for configuration and observability while the
data plane and the full UI (issue #32) are built.

Worked, machine-specific walkthrough:
[deployment-framework-strix-halo.md](deployment-framework-strix-halo.md).

## Status

| Piece | State |
| --- | --- |
| `ollama` (or any engine) container | works today |
| `yardmaster` `--target runtime-proxy` (Go workers) | builds today; PAIR-style Ollama proxy on `:11435` |
| `YM_DATAPLANE_MODE=router` (interim Node router: model-id routing, passthrough/escalation, OpenRouter, metrics) | works today — [ADR-0027](decisions/0027-interim-node-router.md) |
| `yardmaster` `--target runtime` (adds Rust data plane) | blocked on [#36](https://github.com/pakgrou-porg/yardmaster/issues/36) |
| `YM_DATAPLANE_MODE=dataplane` (Switchyard routing, `[routes]`/`[providers]`, `:4000` Anthropic) | blocked on [#26](https://github.com/pakgrou-porg/yardmaster/issues/26) |
| `yardmaster-console` (Config / Backends / Metrics / Agent) | works today, **bundled into the `yardmaster` container** (ADR-0026); Metrics fills in with the data plane |
| plaintext routing through the proxy to an unmanaged sibling engine | [#47](https://github.com/pakgrou-porg/yardmaster/issues/47) |

## Deployment model

**One Docker host = one node.** A cluster is N hosts each running the stack,
paired with the PIN. The container runs the **router and console**, not the
engines — run engines as their own service/host and Yardmaster fronts them.

## Topology: three containers, one namespace (ADR-0026)

| Container | Runs |
| --- | --- |
| `ollama` (or any engine) | the engine. **Owns the network namespace**; every published port is declared here. |
| `yardmaster` | `nvpair-ui-broker` + Go workers (proxy `:11435`) + **the interim router** (`:4000`) + **the Console** (`:8770`) + a LAN bridge (`:11430 → :4000`). |
| `yardmaster-harness` | `dsh web` (`:3080`, loopback) + its Basic-Auth reverse proxy (`:3081`). Separate because it runs model-generated code. |

The `yardmaster` entrypoint registers the local engine as a **manual node** at
`127.0.0.1:11434` (from `YM_LOCAL_ENGINE_URL`), so engine and router share
loopback: the two Yardmaster containers run `network_mode: service:ollama`. Each
starts as root (`user: "0:0"`), chowns its named volume, then drops to uid 10001
— **no init container**. Each supervises its children and exits (Docker restarts
the unit) if any dies. The broker's stdin is held open on a FIFO, so **no
`stdin_open` / `tty`**. See
[ADR-0024](decisions/0024-container-sibling-engine-wiring.md) for the engine
wiring.

## The port model (read this)

| Port | Who listens | Publish? |
| --- | --- | --- |
| `11434` | the engine (Ollama), loopback in the namespace | optional (`"11434:11434"`) for engine-direct |
| `11435` | the Yardmaster **proxy** | **no** — loopback-only for plaintext (403 otherwise) |
| `11430` | the LAN bridge (in `yardmaster`) → the router `:4000` (or the proxy `:11435` in `proxy` mode) | **yes** — `"11435:11430"`; the LAN entry point for inference |
| `4000` | the interim **router** (`YM_DATAPLANE_MODE=router`); `YM_ROUTER_BIND` gates it | loopback by default |
| `8770` | the bundled **Console** | `"${YM_BIND:-127.0.0.1}:8770:8770"` |
| `3081` | the Harness **auth proxy** (in `yardmaster-harness`) → `127.0.0.1:3080` | `"${YM_BIND:-127.0.0.1}:3080:3081"` — dsh won't bind `0.0.0.0` |
| `3080` | `dsh web`, loopback | via the auth proxy above |
| `4000` | the data plane's Anthropic + `/health` + `/metrics` | only in `dataplane` mode |
| `14318` | PAIR node telemetry (plaintext) | **never** publish off-host |

**The proxy refuses non-loopback plaintext with `403`** (PAIR's security model;
`docs/security.md`). The LAN bridge makes a fresh `127.0.0.1` connection so plain
LAN clients on published `:11435` are served.

Common mistakes: engine on `11435` (collides with the proxy); expecting the
proxy on `11434`; publishing the raw proxy port and getting `403` from every LAN
client.

## Stacks

| File | Use |
| --- | --- |
| [`deploy/portainer/yardmaster-node.stack.yml`](../deploy/portainer/yardmaster-node.stack.yml) | single node: `ollama` + `yardmaster` + `yardmaster-harness`. The normal case. |
| [`deploy/portainer/yardmaster-bridge.stack.yml`](../deploy/portainer/yardmaster-bridge.stack.yml) | Docker Swarm / no shared-namespace. **No auto-advertise, no mDNS** — manual config only. |
| [`deploy/portainer/examples/framework-strix-halo.stack.yml`](../deploy/portainer/examples/framework-strix-halo.stack.yml) | the node stack with ROCm GPU access, tuned for a Framework Desktop / 128 GB. Ships an OpenRouter-enabled `yardmaster.toml.example`. |

Deploy in Portainer with **Stacks → Add stack → Repository** (URL
`https://github.com/pakgrou-porg/yardmaster`, ref `refs/heads/main`, the compose
path above). The first deploy builds `yardmaster` from the repo (Go workers +
bundled Console).

## Persistent state

Two named volumes:

```
yardmaster-data      -> /data     (yardmaster container)
  Nvidia Corporation/Personal AI Router/
  ├── cluster/               node.crt, node.key, trusted/   ← mTLS identity + pins
  ├── yardmaster.toml        (or symlinked from a :ro bind mount at /config)
  ├── yardmaster-metrics.db
  ├── console-auth.json      ← the admin credential (scrypt hash)
  └── logs/
yardmaster-harness   -> /dshhome  (yardmaster-harness container; mounted :ro in yardmaster)
  profiles/web/cordis.patch.yml   ← auto-written dsh config; sessions; cookie secret; web-url
```

Each entrypoint chowns its own volume on start — no `yardmaster-init`.

Back it up — losing `cluster/` means re-pairing:

```bash
docker run --rm -v yardmaster-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/yardmaster-data.tgz -C /data .
```

## Configuring `yardmaster.toml`

Use the **Console** (Config tab): edit, **Validate** (mirrors
`switchyard-server --dry-run` strictness), **Save**. Or bind-mount it read-only
at `/config/yardmaster.toml` (keep `:ro,Z` on SELinux hosts) and the Console
writes the data-dir fallback copy. In `runtime-proxy` mode the proxy does not
read it — the Console does, and the data plane will.

Schema is a **strict superset of Switchyard's** (`schema_version`,
`[llm_clients]`, `[targets]`, `[routes]`, plus `[providers.*]`, `[egress]`,
`[tiers.*]`, …). There is no `[engines.*]` table; `[cluster]` is broker-written.
See [routing.md](routing.md) and [providers.md](providers.md).

## The Dockerfile targets

```
docker build -f docker/Dockerfile --target runtime-proxy -t yardmaster:proxy .   # today (Go workers + Console + dsh)
docker build -f docker/Dockerfile                          -t yardmaster:full  .   # adds the Rust data plane; needs #36
```

The `yardmaster` and `yardmaster-harness` services use the **same image** — the
harness service just overrides the entrypoint. The standalone
`packages/yardmaster-console/Dockerfile` still builds the Console alone if you
want it separately.

## Pairing two containerized nodes

Deploy the stack on each host. Read the PIN and pair via the bundled TUI until
the headless helper lands ([#46](https://github.com/pakgrou-porg/yardmaster/issues/46)):

```bash
docker exec -it yardmaster /opt/yardmaster/bin/nvpair-tui
```

## The agent (DeepSeek Harness)

`yardmaster-harness` runs `dsh web` on loopback `:3080` (dsh refuses `0.0.0.0` —
it executes model code), published via its **auth-proxy** child
(`docker/auth-proxy.mjs`, a dependency-free Node HTTP + WebSocket reverse proxy).

**Auto-configured for Yardmaster.** The entrypoint writes
`$DSH_HOME/profiles/web/cordis.patch.yml` (marker on line 1) configuring
`@deepseek-ai/dsh-llm-pi-ai` with a `yardmaster` route
(`baseURL: http://127.0.0.1:11435/v1`, `api: openai-completions`, `models:` from
`YM_HARNESS_MODELS`) and `agent-default-model` = that route + `YM_HARNESS_MODEL`
(default `deepseek-r1:32b`). `dsh` therefore routes every request through the
Yardmaster proxy with no manual step. A hand-written overlay without the marker
on line 1 is left untouched. `dsh web` does **not** accept `--set`.

**Persistence.** `DSH_HOME` is the dedicated `yardmaster-harness` volume, so the
signed-cookie secret, sessions, and credentials survive restarts. The entrypoint
also writes the current tokened URL to `$DSH_HOME/web-url`; the `yardmaster`
container mounts that volume `:ro` and its Console **Agent** tab embeds/links it
(host rewritten to match your request).

**LAN + auth.** `${YM_BIND:-127.0.0.1}` gates the published `:8770`/`:3080`. Set
`YM_BIND=0.0.0.0` + `YM_LAN_HOST=<host-ip>` for the LAN. Auth is **on by
default** and shared (see below) — the harness proxy verifies the same
credential and returns `503` until it exists.

## Upgrades

Pin the build ref / image tag; redeploy. The `/data` volume carries identity and
config across the upgrade. `#main` tracks `main` — don't rely on it for anything
you care about.

## Authentication (ADR-0026)

One admin credential (scrypt hash at
`/data/Nvidia Corporation/Personal AI Router/console-auth.json`, survives
restarts) protects **both** the Console and the Harness. **On by default:**

- No credential configured → the Console serves a one-time setup page and
  refuses everything else; the Harness proxy returns `503`.
- `YM_AUTH_USER` + `YM_AUTH_PASS` (or `YM_AUTH_PASS_FILE`) pre-seed it from the
  stack env instead of the setup page.
- `YM_AUTH_DISABLED=1` turns it off entirely — **loopback dev only**.
- `/healthz` is always open. `dsh` keeps its own launch-token + cookie
  underneath.

Do the first-run setup with `YM_BIND=127.0.0.1`, then open the LAN.

## Security notes specific to containers

- Plaintext inference ingress is loopback-only; the published `:11435` (via the
  LAN bridge) is the entry point.
- The two Yardmaster containers start as root only to chown their volume, then
  drop to `uid 10001`. The Console writes `yardmaster.toml` + the auth file; it
  never handles provider API keys and never reads prompt/response content.
- Node telemetry `14318` is plaintext (inherited from PAIR); `[cluster]
  telemetry_auth = "mtls"` on shared networks. Never publish it.
- HTTP Basic Auth is cleartext over HTTP. For TLS / SSO, keep
  `YM_BIND=127.0.0.1` and put a real reverse proxy in front.

## Known gaps

Tracked in [#46](https://github.com/pakgrou-porg/yardmaster/issues/46),
[#47](https://github.com/pakgrou-porg/yardmaster/issues/47),
[#36](https://github.com/pakgrou-porg/yardmaster/issues/36),
[#26](https://github.com/pakgrou-porg/yardmaster/issues/26): no published
`ghcr.io` image yet (build from source), `dataplane` mode, headless pairing,
deterministic proxy→sibling-engine routing.
