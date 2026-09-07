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
| `yardmaster` `--target runtime` (adds Rust data plane) | blocked on [#36](https://github.com/pakgrou-porg/yardmaster/issues/36) |
| `YM_DATAPLANE_MODE=dataplane` (Switchyard routing, `[routes]`/`[providers]`, `:4000` Anthropic) | blocked on [#26](https://github.com/pakgrou-porg/yardmaster/issues/26) |
| `yardmaster-console` (Config / Backends / Metrics / Agent) | works today; Metrics fills in with the data plane |
| plaintext routing through the proxy to an unmanaged sibling engine | [#47](https://github.com/pakgrou-porg/yardmaster/issues/47) |

## Deployment model

**One Docker host = one node.** A cluster is N hosts each running the stack,
paired with the PIN. The container runs the **router and console**, not the
engines — run engines as their own service/host and Yardmaster fronts them.

## Topology: one shared network namespace

The broker's auto-advertise loop probes `127.0.0.1:11434` for the local engine,
so the engine and the proxy must share loopback. The stacks put the **`ollama`**
service in charge of the namespace and run `yardmaster` and `yardmaster-console`
with `network_mode: service:ollama`. Every published port is declared on the
`ollama` service.

## The port model (read this)

| Port | Who listens | Publish? |
| --- | --- | --- |
| `11434` | the engine (Ollama), on loopback in the namespace | optional (`"11434:11434"`) for engine-direct |
| **`11435`** | the Yardmaster **proxy** — its headless default (nothing calls `set-port` without a UI) | **yes — point clients here** |
| `8770` | the Yardmaster **Console** | host-loopback only (`"127.0.0.1:8770:8770"`) |
| `4000` | the data plane's Anthropic + `/health` + `/metrics` | only meaningful in `dataplane` mode |
| `14318` | PAIR node telemetry (plaintext) | **never** publish off-host |
| `3080` | the dsh Web UI, if run in-namespace | host-loopback only |

Common mistakes: putting the engine on `11435` (collides with the proxy → the
broker refuses to wire it); expecting the proxy on `11434`; health-checking
`11434` when the proxy is on `11435`.

## Stacks

| File | Use |
| --- | --- |
| [`deploy/portainer/yardmaster-node.stack.yml`](../deploy/portainer/yardmaster-node.stack.yml) | single node: `ollama` + `yardmaster` + `yardmaster-console`, shared namespace. The normal case. |
| [`deploy/portainer/yardmaster-bridge.stack.yml`](../deploy/portainer/yardmaster-bridge.stack.yml) | Docker Swarm / no shared-namespace. **No auto-advertise, no mDNS** — manual config only. |
| [`deploy/portainer/examples/framework-strix-halo.stack.yml`](../deploy/portainer/examples/framework-strix-halo.stack.yml) | the node stack with ROCm GPU access, tuned for a Framework Desktop / 128 GB. |

Deploy in Portainer with **Stacks → Add stack → Repository** (URL
`https://github.com/pakgrou-porg/yardmaster`, ref `refs/heads/main`, the compose
path above). The first deploy builds `yardmaster` and `yardmaster-console` from
the repo.

## Persistent state

Everything lives under `/data` (one named volume). PAIR layout inside it:

```
/data/Nvidia Corporation/Personal AI Router/
├── cluster/            node.crt, node.key, trusted/   ← the mTLS identity + pins
├── yardmaster.toml     (or symlinked from a :ro bind mount at /config)
├── yardmaster-metrics.db
└── logs/
```

`yardmaster-init` (an ephemeral `alpine`) runs `chown -R 10001:10001 /data` so
the non-root containers can write.

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
docker build -f docker/Dockerfile --target runtime-proxy -t yardmaster:proxy .   # today
docker build -f docker/Dockerfile                          -t yardmaster:full  .   # needs #36
docker build -f packages/yardmaster-console/Dockerfile     -t yardmaster-console .
```

## Pairing two containerized nodes

Deploy the stack on each host. Read the PIN and pair via the bundled TUI until
the headless helper lands ([#46](https://github.com/pakgrou-porg/yardmaster/issues/46)):

```bash
docker exec -it yardmaster /opt/yardmaster/bin/nvpair-tui
```

## The agent (DeepSeek Harness)

Run `dsh` in the same namespace on `127.0.0.1:3080`; it shows in the Console's
**Agent** tab. Until the `dsh-yardmaster` adapter has a data plane, point dsh's
built-in OpenAI adapter at the proxy (`http://127.0.0.1:11435/v1`) so Yardmaster
still does placement. See the Strix Halo doc §7. The dsh child inherits an
environment stripped of `*_API_KEY` / `*_TOKEN` / `*_SECRET` (ADR-0016). Do not
publish `3080` off-host.

## Upgrades

Pin the build ref / image tag; redeploy. The `/data` volume carries identity and
config across the upgrade. `#main` tracks `main` — don't rely on it for anything
you care about.

## Security notes specific to containers

- Plaintext inference ingress is loopback-only **inside the namespace**; the
  proxy port you publish (`11435`) is the LAN entry point.
- Images run as non-root (`uid 10001` / `10002`). The Console can write
  `yardmaster.toml`; it never handles API keys and never reads prompt/response
  content.
- Node telemetry `14318` is plaintext (inherited from PAIR). `[cluster]
  telemetry_auth = "mtls"` on shared networks.
- Do not publish `8770` (Console), `3080` (dsh), or `14318` to an untrusted
  network.

## Known gaps

Tracked in [#46](https://github.com/pakgrou-porg/yardmaster/issues/46),
[#47](https://github.com/pakgrou-porg/yardmaster/issues/47),
[#36](https://github.com/pakgrou-porg/yardmaster/issues/36),
[#26](https://github.com/pakgrou-porg/yardmaster/issues/26): no published
`ghcr.io` image yet (build from source), `dataplane` mode, headless pairing,
deterministic proxy→sibling-engine routing.
