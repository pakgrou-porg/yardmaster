<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 2. Initial commit series is a bootstrap; subsystems land behind tracking issues

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

The build specification describes a multi-language system (Rust data plane, Go
services, Electron desktop, a TypeScript harness plugin) with cross-platform CI,
Docker Compose integration tests, and a tagged release. The environment used for
the initial bootstrap has Node, npm, git, and Docker but **no Rust, Go, or pnpm
toolchain**, so the Rust crates, Go services, and desktop app cannot be compiled
or tested here. Specification section 8 anticipates partial completion: "If a
step cannot be completed, do not skip silently: commit what works, open a GitHub
issue in the repo describing exactly what is missing and why, label it blocked,
and continue."

## Decision

The initial commit series delivers: the repository, all legal and governance
files, the `git subtree` import of PAIR `services/` and `desktop/`, a Cargo
workspace with buildable-by-design crate scaffolds (real manifests, pinned
Switchyard git dependencies, typed skeletons), the Go `yardmaster-lan-scanner`
module scaffold, the `packages/` harness plugin and bundle scaffolds, all CI
workflows, the full `docs/` set with CI-validated TOML examples, and this ADR
set. Every subsystem whose implementation requires an iterative build/test
environment is tracked by a GitHub issue labelled `blocked`, referenced from the
crate's `README.md`.

## Alternatives considered

- **Do nothing until a full build environment is available** — leaves no shared
  artifact to build on and contradicts the "work end to end, commit what works"
  instruction.
- **Claim subsystems are complete without compiling them** — dishonest and
  unverifiable.

## Consequences

`main` builds a coherent tree of scaffolds and documentation from day one. The
`blocked` issue list is the authoritative backlog. CI jobs that need a real
build are present and will fail until their subsystem lands; the branch
protection required-checks list is applied but the maintainer merges the
bootstrap series directly (pre-protection) per specification section 2.
