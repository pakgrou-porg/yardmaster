<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 22. Headless container deployment: one node per host, host networking, engines out of the container

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Yardmaster's first-class shape is the PAIR desktop app (Electron main supervises
the broker) or the TUI (which owns its own broker). A common ask is to run a
node as a service under Docker / Portainer in a homelab. Nothing in the spec
covers this; it must not change the product's local-by-default posture.

Facts that constrain the design:

- The broker (`nvpair-ui-broker`) already runs headless: its default IPC is
  stdin/stdout and it only needs Electron as a launcher, not a dependency.
- The per-node data directory is resolved purely from `os.UserConfigDir()`
  (`$XDG_CONFIG_HOME` on Linux) as `<base>/Nvidia Corporation/Personal AI
  Router` — there is no `NVPAIR_HOME`-style override.
- Discovery uses mDNS and the data plane takes over host ports 11434 / 1234.
- The engine manager installs and supervises Ollama / LM Studio as host
  processes — behaviour that does not belong in a container.

## Decision

Ship a headless container (`docker/Dockerfile`, `docker/entrypoint.sh`) and
Portainer stack templates (`deploy/portainer/`) with these choices:

1. **One container per Docker host.** A cluster is N hosts each running the
   stack, paired with the PIN. Two nodes on one host would collide on ports.
2. **Host networking is the primary mode** (`network_mode: host`), so mDNS and
   port takeover work exactly as a native install. A bridge variant is provided
   for Swarm / restricted hosts, documented as losing discovery.
3. **The container runs the router, not the engines.** Engines run on the host,
   in a sibling container, or on other nodes, and are reached as promoted LAN
   targets, manual nodes, or paired peers. The image does not attempt engine
   installation.
4. **The data directory is redirected with `XDG_CONFIG_HOME=/data`** and a
   single named volume at `/data` carries cluster identity, pins,
   `yardmaster.toml`, and the metrics DB.
5. **`yardmaster.toml` may be bind-mounted read-only at `/config`** and is
   symlinked into the data dir by the entrypoint, so a Portainer config / GitOps
   file stays the source of truth.
6. **`YM_DATAPLANE_MODE`** selects `proxy` (PAIR's two proxy workers, works
   today) or `dataplane` (the single Rust worker, after ADR-0005 / issue #26).
7. **The optional in-container `dsh` agent** runs on loopback only, in a
   subshell with `*_API_KEY` / `*_TOKEN` / `*_SECRET` stripped (ADR-0016), and
   its Web UI is never published.
8. The image runs as a non-root user; node telemetry on 14318 stays plaintext
   (ADR-0018) and must not be published off-host.

## Alternatives considered

- **A distroless / scratch image with only the data plane** — cannot pair,
  discover, schedule, or manage a cluster without the broker and Go workers.
- **Bridge networking as the default** — breaks mDNS discovery, which is half
  the product; only acceptable as an explicit fallback.
- **Running the engine manager in-container with host mounts** — needs broad
  host access (process control, package install, GPU) that undermines the
  container boundary; out of scope (non-goal: no new managed engines).
- **An `NVPAIR_HOME` env override upstream** — would be cleaner than
  `XDG_CONFIG_HOME`, but is a PAIR change; `XDG_CONFIG_HOME` already works and
  keeps the container off the patch path.

## Consequences

Homelab users get a Portainer stack. The image build is gated on the Rust
workspace compiling (issue #36) and the full `dataplane` mode on the broker flag
migration (issue #26); until then the container is a working PAIR-style router
without Switchyard model selection. Headless pairing currently needs the bundled
TUI via `docker exec`; a pairing helper command is tracked in issue #46, which
also tracks publishing the `ghcr.io` image and finishing `dataplane` mode.
