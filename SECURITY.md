<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Security Policy

Yardmaster is an independent open-source project. It is **not** an NVIDIA or
DeepSeek product. **Do not report Yardmaster vulnerabilities to NVIDIA PSIRT or
to DeepSeek.** Reports about the upstream projects themselves should go to their
respective maintainers.

## Reporting a vulnerability

Report a suspected vulnerability in Yardmaster **privately**:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting is
   enabled for this repository).

Do not open a public issue or pull request for a security problem. If a report
is disclosed publicly by mistake, the maintainer may limit discussion and move
it to a private advisory.

Please include:

- The affected version, tag, or commit.
- The vulnerability class and the component (crate, service, package, or CI).
- Reproduction steps and, when possible, a proof of concept.
- The expected impact.

Remove unrelated personal information, credentials, private keys, tokens,
prompts, and model data before sending.

The maintainer triages reports on a best-effort basis, aims to acknowledge
within 7 days, and coordinates disclosure through a GitHub Security Advisory.

## Scope and trust boundaries

Yardmaster inherits PAIR's process model and its security posture, and adds a
Rust data plane, LAN discovery of non-paired endpoints, optional remote
providers, a metrics store, and a DeepSeek Harness integration. The full model
is documented in [`docs/security.md`](docs/security.md). In short:

- **Plaintext inference ingress is loopback-only.** A non-loopback plaintext
  request is refused with `403` before any body is read. The same TCP port also
  serves an mTLS ingress for paired cluster members (first byte `0x16`).
- **Cluster ingress requires a client certificate pinned for a current cluster
  member.** Unpinned certificates are rejected at the TLS handshake.
- **Prompts and responses are never logged** at any level and are never written
  to the metrics store, at any locality.
- **Remote (off-LAN) targets are disabled by default.** They require both
  `[egress] allow_remote = true` in `yardmaster.toml` and the desktop toggle,
  and every job that used one is marked in the UI.
- **Provider API keys** are read only from environment variables or the OS
  credential store, never written to `yardmaster.toml`, never sent to the
  renderer, never placed in a decision trace, metric label, or log line.
- **LAN discovery is passive by default** (mDNS browse only) and, when probing
  is enabled, is bounded to RFC 1918 / link-local / ULA ranges, a fixed port
  list, two `GET` requests per host per interval, and 500 ms timeouts. A
  discovered endpoint is never used for inference until a human promotes it.
- **The DeepSeek Harness child process** is started only on explicit user
  action, binds `127.0.0.1` only, and inherits an environment stripped of
  `*_API_KEY`, `*_TOKEN`, and `*_SECRET`.

## Inherited exposures

PAIR's node-telemetry endpoint on port `14318` remains plaintext, unchanged.
Yardmaster does not widen it and adds an opt-in `[cluster] telemetry_auth =
"mtls"` flag to move it behind the mTLS personality; the default stays `"plain"`
for PAIR compatibility. See [`docs/security.md`](docs/security.md).

## Supply chain

CI runs `cargo deny`, `cargo audit`, `govulncheck`, `npm audit`, and
`osv-scanner` on every pull request, and they block merge. A CycloneDX SBOM is
attached to each release artifact. Lockfiles (`Cargo.lock`, `go.sum`,
`package-lock.json`, `pnpm-lock.yaml`) are committed and CI builds with
`--locked` / `-mod=readonly` / `--frozen-lockfile`.
