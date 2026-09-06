<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 9. LAN discovery is passive by default; active probing is bounded

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.7 and section 4 require discovery to be "bounded and passive by
default". Active scanning of a network is intrusive and, done carelessly, looks
hostile.

## Decision

`[discovery] lan_scan` defaults to `false`: with it off, `yardmaster-lan-scanner`
only performs mDNS browsing (`_nvpair-node._tcp`, `_ollama._tcp`, `_http._tcp`
with TXT hints, plus service types engines actually advertise). With `lan_scan =
true`, it additionally probes, on the configured `subnets` only, the fixed
`probe_ports` list (`[11434, 1234, 8000, 8080, 5000]`) on hosts that answered ARP
or ICMP in the last `interval_s` (default 60). A probe is exactly one
`GET /v1/models` and one `GET /api/tags` with a 500 ms timeout, at most once per
host per interval. Never outside RFC 1918 / link-local / ULA. `[discovery]
deny_hosts` is honored. A public IP in `subnets` fails config load. Discovered
endpoints are never used for inference until a human promotes them to a
`locality = "lan"` target.

## Alternatives considered

- **Probe by default** — surprises users on shared networks; not local-by-default
  in spirit.
- **Full port scan / service fingerprinting** — explicitly a non-goal
  (section 9); noisy and hostile.

## Consequences

Out of the box, Yardmaster is no louder on the network than PAIR. Tests assert
refusal to probe public space and that an unpromoted endpoint never enters a
placement candidate set.
