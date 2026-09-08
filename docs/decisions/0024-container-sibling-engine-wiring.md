<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 24. Containerised runtime-proxy fronts a sibling engine via manual-node injection

- Status: accepted
- Date: 2026-09-08
- Deciders: @pakgrou-porg

## Context

Verified on the target host (Framework Desktop, Ryzen AI Max+ 395, Fedora 43,
Docker 29.8): a `runtime-proxy` container beside an `ollama/ollama` container
**cannot** route inference through the proxy using PAIR's normal path, for three
independent reasons found in the vendored source:

1. **Auto-advertise needs the host-only engine-manager.** `reconcileAdvertise`
   resolves the local engine port from `nvpair-engine-manager` (`engine:status`);
   an unmanaged sibling engine reports `running:false` → `localEnginePort`
   returns `(0,false)` → the proxy is told `healthy=false` forever.
2. **The port gate needs engine-manager too.** With engine-manager absent,
   `restoreEnabledEnginesAfterPortGate` fails, so
   `runEngineAvailabilityAfterPortGates` returns early and the auto-advertise
   goroutine is **never started** at all.
3. **stdin EOF = shutdown.** The broker treats stdin EOF as "UI disconnected"
   and tears everything down ~seconds after a detached start.

## Decision

The container image and entrypoint work around all three, without patching
Switchyard or PAIR:

- **Remove `nvpair-engine-manager` from the image** at build time. It installs
  and supervises engines as *host* processes — useless in a container — and its
  presence is what blocks (1). Its "could not reserve port 11434" warnings are
  expected and harmless.
- **The entrypoint runs the broker with stdin on a FIFO** it holds open on
  fd 3 (`exec 3<>fifo`) for the life of the container. No `stdin_open`, no
  `docker -i`, no TTY. `trap`/`wait` forward `SIGTERM` for a clean stop
  (measured: ~40 ms).
- **The entrypoint injects one `node/add` frame** into that FIFO for the host
  parsed from `YM_LOCAL_ENGINE_URL` (default delay 10 s, `YM_MANUAL_NODE_DELAY`).
  The broker relays it to `nvpair-manual-nodes`, which probes `<host>:11434`
  (Ollama) / `<host>:1234` (LM Studio) and feeds the result into the proxy's
  discovery overlay. The proxy then has a routing target — verified end to end:
  `POST :11435/v1/chat/completions` reaches the engine and returns a response.
- The engine must therefore sit on `127.0.0.1:11434` (Ollama's default) with the
  proxy on `:11435` (its headless default), sharing one network namespace
  (`network_mode: service:ollama`).

## Alternatives considered

- **Keep engine-manager and hope auto-advertise works** — it demonstrably does
  not for an unmanaged engine (reasons 1–2).
- **`stdin_open: true` in compose** — works for stdin, but users forget it and
  the failure (silent shutdown after 30 s) is baffling; the FIFO makes the
  image self-sufficient.
- **`--ipc <socket>`** — the broker *dials* the IPC endpoint; it needs a parent
  already listening, so it does not help a headless container.
- **A patched broker that accepts a `--manual-node` flag** — would be cleaner;
  filed as a follow-up on issue #47, but the entrypoint approach needs no
  upstream change.

## Consequences

A single-box "router in front of one sibling engine" deployment works today in
`runtime-proxy` mode. Multi-engine / multi-node still needs pairing or, better,
`YM_DATAPLANE_MODE=dataplane` (#26/#36). The image can modify its own
`/opt/yardmaster/bin` (chowned to uid 10001) — acceptable for a
single-purpose container. `HSA_OVERRIDE_GFX_VERSION` is **not** needed on this
host: `rocminfo` enumerates the Radeon 8060S as `gfx1100`, which ROCm supports
natively.
