<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Security

This describes the trust boundaries visible in the source, what changed versus
PAIR, and the egress model. It is not a claim that every deployment is secure.
Report vulnerabilities per [SECURITY.md](../SECURITY.md) — **not** to NVIDIA
PSIRT or DeepSeek.

## What Yardmaster inherits from PAIR unchanged

- Electron renderer reaches Electron main only through the typed preload bridge.
- The broker supervises Go workers over stdio JSON-RPC with no per-message
  bearer token; it relies on OS process and endpoint permissions.
- Pairing bootstraps trust with a low-entropy six-digit PIN. Pair only on a
  trusted network; the PIN is not a durable credential.
- Cluster mTLS protects participating cluster channels only.
- Supervised workers run under the user's OS account.

## What changed

### Inference ingress: loopback plaintext, mTLS for peers

`yardmaster-dataplane` applies PAIR's two-personalities rule on 11434, 1234, and
4000: first byte `0x16` → mTLS cluster ingress; anything else → plaintext,
**refused with `403` before any body is read** unless the peer address is
loopback. Cluster ingress requires a client certificate **pinned for a current
cluster member**; an unpinned certificate is rejected at the TLS handshake, not
after. Acceptance tests: a non-loopback plaintext connection from a separate
network namespace gets `403`; an unpinned client is rejected at handshake.

### One trust store

`crates/yardmaster-cluster-trust` reads `nvpair-cluster-manager`'s existing
identity, certificate, key, and pin-store files and mirrors their format. It
**writes nothing** and creates no second identity or trust store.

### No prompt or response content anywhere

Not in logs (any level), not in the metrics store, not in decision traces, at
any locality. Enforced by: a unit test grepping the data-plane crates for
`tracing::` calls that reference body fields, a `clippy.toml` `disallowed-methods`
entry for the body types' `Debug` impls in log macros, and a metrics schema
allowlist test.

### Egress model

| `locality` | Reaches | Gate |
| --- | --- | --- |
| `cluster` (default) | a paired node, resolved by placement | always allowed |
| `lan` | a private-range plaintext endpoint that is not a paired node | `[egress] allow_lan` (default `true`) |
| `remote` | any non-loopback, non-private-range host (cloud) | `[egress] allow_remote` (default **`false`**) **and** the desktop Settings → Egress toggle |

When a remote target is enabled, the UI shows a persistent indicator on the node
card and on every job that used it. Config validation **rejects** a route whose
selected or judge target is `remote` while `allow_remote = false`. Judge and
classifier calls carry prompt content and obey the same locality ceiling as the
primary request; a `remote` judge additionally needs `judge_egress = "allow"`.
Budgets are enforced **before dispatch**: a request whose estimated cost would
exceed the remaining daily budget is not sent and the route falls to its next
tier.

### Provider secrets

Read only from an environment variable (`api_key_env`) or the OS credential
store (`api_key_ref`) via the Electron main process. Never written to
`yardmaster.toml`, never sent to the renderer, never in a decision trace, a
metric label, a log line, or an error message that echoes a request. A
canary-key test serializes every renderer-bound type with a fixture containing a
canary string and asserts its absence. Provider HTTP clients pin TLS 1.2+,
verify certificates, and never follow a redirect to a different host.
`base_url` overrides for `openrouter` / `venice` / `kie` must be HTTPS; HTTP is
accepted only for `openai_compatible` on a private range.

### LAN discovery

Passive by default (mDNS browse only). With `[discovery] lan_scan = true`,
probing is bounded to RFC 1918 / link-local / ULA, the fixed `probe_ports` list,
exactly `GET /v1/models` + `GET /api/tags` per host per interval, 500 ms
timeouts, `deny_hosts` honored. A public IP or CIDR in `subnets` fails config
load. A discovered endpoint never enters a placement candidate set until a human
promotes it. See [discovery.md](discovery.md).

### The DeepSeek Harness child

Started only from the desktop or TUI on explicit user action. Binds `127.0.0.1`
only. Inherits an environment with `*_API_KEY`, `*_TOKEN`, `*_SECRET` stripped
(tested). The embedded webview has `nodeIntegration` off, `contextIsolation` on,
`sandbox` on, and a `will-navigate` handler that refuses any origin other than
the harness's loopback URL. The plugin's `telemetry/*` forwarder sends counts
and identifiers only to the loopback `metrics.ingest`, which accepts loopback
callers only and validates against the event schema. dsh's `SAFETY.md` governs
what the agent may do on the machine; Yardmaster does not weaken it and does not
claim to enforce it.

### Metrics store

SQLite (WAL) in PAIR's data directory, created `0600` on POSIX / user-only ACL
on Windows. Every column is on an allowlist asserted by a schema test: no
prompt/completion text, no full client addresses beyond a loopback/non-loopback
classification. OTLP export is off unless an endpoint is configured, and that
endpoint must be HTTPS or loopback. Prometheus labels are bounded (`route`,
`tier`, `node`, `provider`, `engine`, `model`, status class, `locality`) —
never a request id or an address; a label-cardinality test rejects any value
that looks like a UUID or an address.

## Inherited exposures

- **Node telemetry on port `14318` remains plaintext**, exactly as in PAIR.
  Yardmaster does not widen it. `[cluster] telemetry_auth = "mtls"` (default
  `"plain"`) moves `node-info` behind the mTLS personality; the desktop shows a
  one-time notice recommending `mtls` on shared networks. See
  [decisions/0018](decisions/0018-telemetry-auth-default-plain.md).
- **"Local-first" is a topology, not a guarantee.** Engines, model catalogs,
  update systems, and enabled remote providers may contact external services.

## Supply chain

`cargo deny`, `cargo audit`, `govulncheck`, `npm audit --audit-level=high`, and
`osv-scanner` run in CI and block merge. `cargo geiger` fails on unannotated
`unsafe`. A CycloneDX SBOM is attached to each release artifact. Lockfiles are
committed; CI builds with `--locked` / `-mod=readonly` / `--frozen-lockfile`.
