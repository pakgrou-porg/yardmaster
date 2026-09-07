<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Deploying Yardmaster with Docker and Portainer

Yardmaster's first-class shape is a **desktop app**. This page covers the
**headless container** path: the `nvpair-ui-broker` control plane plus every Go
worker, the Rust data plane, and the LAN scanner, with no Electron and no
desktop UI. It suits a homelab / Portainer deployment where you want the router
to run as a service.

> **Status.** The image build is wired but not yet green: the Rust workspace
> does not compile in this environment ([#36](https://github.com/pakgrou-porg/yardmaster/issues/36))
> and the broker's `proxy` → `yardmaster-dataplane` flag migration is pending
> ([#26](https://github.com/pakgrou-porg/yardmaster/issues/26)). Until then the
> image runs in `YM_DATAPLANE_MODE=proxy` — PAIR's `ollama-proxy` /
> `lmstudio-proxy` workers — which is a working router without Switchyard model
> selection or the Anthropic ingress. The full path is tracked in
> [#46](https://github.com/pakgrou-porg/yardmaster/issues/46).

## The deployment model

**One container per Docker host.** A "cluster" is two or more hosts each running
this stack, paired with the six-digit PIN. The container does **not** run
multiple nodes — that is inherently multiple machines, and with host networking
two nodes on one host would collide on ports 11434 / 1234.

The container runs the **router**, not the engines. Yardmaster does not install
or supervise Ollama / LM Studio inside a container. Run engines separately (on
the host, in a sibling container, or on other nodes) and point Yardmaster at
them as promoted LAN targets, manual nodes, or paired cluster peers.

## Networking

| Mode | Stack file | mDNS discovery | Port takeover | Use when |
| --- | --- | --- | --- | --- |
| **host** | `yardmaster-node.stack.yml` | works | works (11434/1234/4000) | standalone Docker host (the normal case) |
| **bridge** | `yardmaster-bridge.stack.yml` | **broken** — does not cross the bridge | published via `-p` on the host LAN IP | Docker Swarm, or host networking is not allowed |

With the bridge variant you must use manual nodes / explicit `yardmaster.toml`
targets and pair by typing the peer's address, and keep `[discovery] lan_scan =
false` (the container's subnet is not your LAN).

## Persistent state

Everything that must survive a restart lives under `/data` (mount a volume
there). PAIR's layout inside it:

```
/data/Nvidia Corporation/Personal AI Router/
├── cluster/            node.crt, node.key, trusted/  ← the mTLS identity and pin store
├── yardmaster.toml     (symlinked from /config/yardmaster.toml if you bind-mount one)
├── yardmaster-metrics.db
└── logs/
```

**Back up the volume.** Losing `cluster/` drops the node out of the mTLS cluster
and you must re-pair.

```bash
docker run --rm -v yardmaster-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/yardmaster-data.tgz -C /data .
```

## Deploy in Portainer

### Option A — from this Git repository (recommended)

1. **Stacks → Add stack → Repository.**
2. Repository URL `https://github.com/pakgrou-porg/yardmaster`, reference
   `refs/heads/main`, Compose path
   `deploy/portainer/yardmaster-node.stack.yml`.
3. Add environment variables (see `deploy/portainer/.env.example`). At minimum
   nothing is required; set `YM_IMAGE` to a pinned tag once releases exist.
4. **Deploy the stack.**

### Option B — web editor

Paste `deploy/portainer/yardmaster-node.stack.yml` into the editor, fill in the
environment variables, deploy.

### Build from source instead of pulling an image

Edit the stack: comment out `image:` and uncomment the `build:` block. Portainer
builds `docker/Dockerfile` with the repo as context. This needs build-time
network access for the pinned Switchyard git deps and the PAIR module deps.

### Providing `yardmaster.toml`

- **Simple:** deploy first, then `docker cp` or edit the file inside the volume
  at the path above and restart.
- **GitOps:** set `YM_CONFIG_FILE` to an absolute host path (or a Portainer
  config mounted into the host) and the entrypoint links it read-only into the
  data dir. Start from `deploy/portainer/yardmaster.toml.example`.

Validate a config without deploying:

```bash
docker run --rm -v "$PWD/yardmaster.toml:/config/yardmaster.toml:ro" \
  --entrypoint /opt/yardmaster/bin/yardmaster-dataplane \
  ghcr.io/pakgrou-porg/yardmaster:latest dry-run --config /config/yardmaster.toml
```

## Pairing two containerized nodes

1. Deploy the stack on host A and host B (host networking).
2. On host A, read the PIN from the logs / a JSON-RPC client:
   `docker logs yardmaster 2>&1 | grep -i pair`. (A headless pairing helper
   command is tracked in [#46](https://github.com/pakgrou-porg/yardmaster/issues/46);
   until then use the TUI: `docker exec -it yardmaster /opt/yardmaster/bin/nvpair-tui`.)
3. On host B enter host A's PIN. The mTLS cluster forms; `cluster/trusted/` on
   both volumes now holds the peer.

## Environment variables

See `deploy/portainer/.env.example`. Highlights:

| Var | Default | Meaning |
| --- | --- | --- |
| `YM_IMAGE` | `ghcr.io/pakgrou-porg/yardmaster:latest` | image to run |
| `NVPAIR_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `YM_DATAPLANE_MODE` | `proxy` | `proxy` (today) or `dataplane` (after #26) |
| `YM_AGENT` | `0` | `1` runs `dsh web` on `127.0.0.1:3080` inside the container |
| `YM_HEALTHCHECK_URL` | `http://127.0.0.1:11434/api/tags` | container healthcheck target |
| `YM_CONFIG_FILE` | `/dev/null` | host path of a `yardmaster.toml` to bind-mount |
| `OPENROUTER_API_KEY` / `VENICE_API_KEY` / `KIE_API_KEY` | unset | provider keys, passed to the data plane, never written to the config file |

## The agent (DeepSeek Harness) in a container

Set `YM_AGENT=1`. `dsh web` binds `127.0.0.1:3080` **inside the container** — it
is not published and should not be. To use it, `docker exec` into the container
or run `dsh headless` as a one-shot:

```bash
docker exec -it yardmaster env -u OPENROUTER_API_KEY -u VENICE_API_KEY -u KIE_API_KEY \
  dsh headless --profile yardmaster-headless "summarize ./README.md"
```

The entrypoint strips `*_API_KEY` / `*_TOKEN` / `*_SECRET` from the agent's
environment (ADR-0016). Exposing the dsh Web UI beyond loopback is out of scope.

## Upgrades

Pin `YM_IMAGE` to a release tag. To upgrade: bump the tag and redeploy the
stack. The volume carries identity and config across the upgrade. `latest`
tracks `main` and can change under you — do not run it in anything you care
about.

## GPU

The router needs no GPU. If you co-locate an engine (see
`yardmaster-node-with-ollama.stack.yml`), give **the engine** the GPU via
`deploy.resources.reservations.devices` and the NVIDIA Container Toolkit.

## Security notes specific to containers

- Plaintext inference ingress is still loopback-only inside the container's
  network namespace; with host networking "loopback" is the host's loopback.
  Cluster peers use mTLS. See [security.md](security.md).
- The image runs as a non-root user (`uid 10001`). The volume is chowned by the
  entrypoint on first start.
- Node telemetry on `14318` is plaintext (inherited from PAIR). Do not publish
  it off-host; set `[cluster] telemetry_auth = "mtls"` on shared networks.
- Do not publish `3080` (the dsh Web UI) or `4000`'s `/metrics` to an untrusted
  network.

## Known gaps

Tracked in [#46](https://github.com/pakgrou-porg/yardmaster/issues/46) and its
dependencies:

- Image does not build until the Rust workspace compiles ([#36](https://github.com/pakgrou-porg/yardmaster/issues/36)).
- `YM_DATAPLANE_MODE=dataplane` needs the broker flag migration ([#26](https://github.com/pakgrou-porg/yardmaster/issues/26)).
- No `ghcr.io` image is published yet; use the build-from-source path or wait
  for the first release ([#39](https://github.com/pakgrou-porg/yardmaster/issues/39)).
- Headless pairing without the TUI needs a helper command ([#46](https://github.com/pakgrou-porg/yardmaster/issues/46)).
