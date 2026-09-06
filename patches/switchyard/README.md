<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# patches/switchyard/

Minimal, build-time patches to NVIDIA NeMo Switchyard, applied only when a
required hook does not exist upstream. **Empty today.**

Rules (see `docs/decisions/0004-switchyard-as-git-dependency.md` and
`../../AGENTS.md`):

- One `*.patch` file per change, `git format-patch` style.
- Every patch starts with a comment block: what it changes, why it is needed,
  and a link to the repo issue that proposes the change upstream.
- Patches are wired in via a `[patch."https://github.com/NVIDIA-NeMo/Switchyard"]`
  section in the workspace `Cargo.toml` pointing at a locally patched checkout
  produced by `scripts/build.sh`.
- Switchyard's `AGENTS.md` is binding for the patched code: no
  `panic!`/`unwrap`/`expect` outside tests, errors via `?`, provider-neutral
  types stay in `switchyard-protocol`.

Anticipated first patch: exposing `switchyard-server`'s HTTP layer as a library
API so `yardmaster-dataplane` can mount it (tracked by a `blocked` issue).
