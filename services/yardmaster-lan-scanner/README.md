<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# yardmaster-lan-scanner

A broker-supervised Go worker that discovers inference endpoints on the LAN that
are **not** paired PAIR nodes. PAIR's `nvpair-node-scanner` finds PAIR nodes;
this finds everything else (Ollama, LM Studio, vLLM, llama.cpp, NIM, generic
OpenAI-compatible) so a human can promote one to a `locality = "lan"` target.

New file. This is not part of the vendored PAIR tree — it is a Yardmaster
addition placed under `services/` so it builds and ships with the other workers.
It carries a Yardmaster SPDX header, not NVIDIA's.

## Safety invariants (implemented in `config.go` / `scanner.go`, tested)

- **Passive by default.** `lan_scan = false` ⇒ mDNS browse only.
- **Private space only.** `Config.Validate()` rejects a public IP or CIDR in
  `subnets` at load. `isPrivate` covers RFC 1918, link-local, and IPv6 ULA.
- **Bounded probe.** Exactly `GET /v1/models` + `GET /api/tags`, 500 ms each,
  at most once per host per interval. No port ranges, no fingerprinting beyond
  response shape.
- **`deny_hosts` honored.**
- **Eviction** after three consecutive misses; last-good inventory kept for
  display.
- **Never sends inference.** Discovery produces candidates only.

## Status

**Scaffold.** Config validation, the endpoint store + eviction, and
classification are implemented and unit-tested (`go test ./...`). The mDNS
browse (`github.com/grandcat/zeroconf`, as used by `nvpair-node-scanner`), the
prober, the broker JSON-RPC handshake, and the `lan.endpoint.updated`
notification are tracked in the repo issues (label `blocked`):
"Implement yardmaster-lan-scanner: mDNS browse + bounded probe + broker
notifications", together with wiring it into `services/build.sh`,
`services/build.bat`, `services/versions.json`, and the broker supervisor.

## Build

```
cd services/yardmaster-lan-scanner && go build -mod=readonly ./...
```

`scripts/build.sh` / `build.ps1` build it and stage it into
`services/build/bin/`.
