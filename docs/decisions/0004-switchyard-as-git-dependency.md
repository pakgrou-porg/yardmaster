<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 4. Consume Switchyard as pinned git dependencies, not a fork

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.1: the data plane is "built from the Switchyard crates
switchyard-protocol, switchyard-translation, switchyard-libsy,
switchyard-llm-client, and the server crate's HTTP layer, consumed as git
dependencies pinned to the recorded SHA. Do not fork Switchyard. If a needed
hook does not exist upstream, add it in a patches/switchyard/ directory as a
minimal patch applied at build time, and open a tracking issue."

Switchyard's workspace (commit `9a743e8...`) exposes these as package names
`switchyard-libsy` (path `crates/libsy`), `switchyard-llm-client` (path
`crates/libsy-llm-client`), `switchyard-protocol` (path `crates/protocol`),
`switchyard-translation`, and `switchyard-server`. Edition 2024, rust-version
1.96.1.

## Decision

Each Yardmaster crate that needs Switchyard depends on it as
`{ git = "https://github.com/NVIDIA-NeMo/Switchyard", rev =
"9a743e89223a0d5b14011f1226d5b068f730a3b8", package = "switchyard-<name>" }`.
`rust-toolchain.toml` pins the toolchain to satisfy edition 2024 and
`rust-version = 1.96.1`. Any unavoidable change to Switchyard is a patch file
under `patches/switchyard/` with a header explaining why and a linked tracking
issue proposing the upstream change; patches are applied at build time by
`scripts/build.sh` / `build.ps1` and `[patch]` entries in the workspace
`Cargo.toml`.

## Alternatives considered

- **Fork Switchyard** — excluded by the specification; creates a maintenance
  burden and divergence risk.
- **Vendor the crates** — same divergence risk, and the specification says git
  dependencies.

## Consequences

Switchyard upgrades are a single `rev` bump plus a patch rebase. If the
`switchyard-server` HTTP layer is not exposed as a library API, a
`patches/switchyard/0001-expose-http-layer.patch` will be needed; a tracking
issue is filed for it during data-plane implementation.
