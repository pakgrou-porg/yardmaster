<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# LAN discovery

PAIR discovers PAIR nodes. Yardmaster **also** discovers inference endpoints on
the LAN that are not paired nodes, so you can promote one to a target without
typing its address. The worker is `services/yardmaster-lan-scanner` (Go),
supervised by the broker alongside `nvpair-node-scanner`. See
[decisions/0009](decisions/0009-lan-discovery-passive-default.md).

## What is browsed (always, when `[discovery]` is not fully off)

mDNS service types:

- `_nvpair-node._tcp` — unpaired PAIR nodes (shown with a **Pair** action).
- `_ollama._tcp`.
- `_http._tcp` with TXT hints.
- Any service type current Ollama, LM Studio, llama.cpp, vLLM, and NIM builds
  actually advertise (verified against those engines, not assumed).

## What is probed (only when `[discovery] lan_scan = true`)

On the configured `subnets` only, and only for hosts that answered ARP or an
ICMP ping in the last `interval_s`:

- The fixed `probe_ports` list — default `[11434, 1234, 8000, 8080, 5000]`.
- Exactly **one `GET /v1/models` and one `GET /api/tags`** per host, 500 ms
  timeout each. Nothing else.
- At most **once per host per interval**.

## What is never probed, under any configuration

- Anything outside RFC 1918, link-local, and IPv6 ULA. A public IP or CIDR in
  `subnets` **fails config load**.
- Any host in `[discovery] deny_hosts`.
- Port ranges, or any port not in `probe_ports`.
- Anything beyond the two GETs — no service fingerprinting beyond response
  shape, no version probing (non-goal, section 9).

## Classification and lifecycle

Each responder is classified `ollama` | `lmstudio` | `vllm` | `llamacpp` | `nim`
| `openai_compatible` from response shape and headers, its model inventory and a
lightweight latency (`GET /v1/models` round trip) recorded, and the record
published to the broker as `lan.endpoint.updated` keyed by `host:port`. Known
endpoints are re-probed every `interval_s`, **evicted after three consecutive
failures**, and their last-good inventory is kept for display.

## Promotion

Discovery produces **candidates only**. A discovered endpoint is never used for
inference until a human promotes it — from the desktop **Discovered** view
("Add as target") or by adding a `locality = "lan"` target to `yardmaster.toml`.
Once promoted, its inventory feeds placement exactly like a cluster node's, with
one difference: it is ordered **after all cluster nodes at equal pressure**,
because Yardmaster has no telemetry for it.

`/v1/models` and `/api/tags` fan-out includes promoted LAN targets. It also
includes **unpromoted** ones, annotated `yardmaster.discovered = true`, only when
`[discovery] list_unpromoted = true` (default `false`).

## Turning it off

| You want | Set |
| --- | --- |
| No active probing (default) | `[discovery] lan_scan = false` |
| No discovery at all | remove `[discovery]` and disable the scanner in the desktop (the worker is `optional` and non-fatal if absent) |
| Probing, but skip a noisy host | add it to `[discovery] deny_hosts` |
| Never see unpromoted endpoints in model lists (default) | `[discovery] list_unpromoted = false` |

Scan activity is logged at `info` with host and port only. Metrics: hosts
probed, responders found, classification counts.
