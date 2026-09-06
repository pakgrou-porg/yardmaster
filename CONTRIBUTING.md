<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Contributing to Yardmaster

Thanks for your interest. Yardmaster composes two NVIDIA projects (NeMo
Switchyard, Personal AI Router) into one two-stage LLM router and ships a
DeepSeek Harness integration on top. Please read this file and
[GOVERNANCE.md](GOVERNANCE.md) before opening a pull request.

## Developer Certificate of Origin (DCO)

Every commit must be signed off:

```bash
git commit -s -m "type(scope): summary"
```

The `Signed-off-by:` trailer must match the commit author. A missing or
mismatched sign-off is fixed by rewriting the commit, not in review. CI enforces
this.

## Commit and PR style

- **Conventional Commits** for every commit and PR title:
  `type(scope): summary` (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`,
  `ci`, `build`). Keep the summary line under ~72 characters.
- Prefer small, focused commits. Every changed line should trace to the stated
  change.
- Release notes are generated from commit messages, so write them for a reader.

## Vendored trees and upstream rules

- `services/` and `desktop/` are vendored from **NVIDIA Personal AI Router** via
  `git subtree`. Within those trees, **PAIR's `AGENTS.md` and `CONTRIBUTING.md`
  are binding** in addition to this file: no TypeScript type casting, absolute
  `@/...` imports, static imports only, "engine" not "backend" in new copy, two-line
  SPDX header on every file, bump `services/versions.json` for any changed
  service binary, and run `npm run service-contracts:check` after any JSON-RPC
  change. Keep changes minimal and upstreamable.
- `patches/switchyard/` holds minimal build-time patches to **NVIDIA NeMo
  Switchyard**. Within that directory, **Switchyard's `AGENTS.md` is binding**:
  no `panic!`/`unwrap`/`expect` in non-test Rust, propagate errors with `?`,
  provider-neutral types stay in `switchyard-protocol`. Every patch carries a
  header explaining why it exists and links a tracking issue proposing the
  upstream change.
- Do **not** vendor or fork DeepSeek Harness. All dsh-facing code lives in
  `packages/dsh-yardmaster/` and `packages/dsh-bundle-yardmaster/` and uses only
  documented dsh extension points.

## New files

Every new source file carries an SPDX header:

```
SPDX-License-Identifier: Apache-2.0
```

plus a `SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller` line (comment
syntax appropriate to the language). Do **not** alter the NVIDIA SPDX or
copyright headers on vendored files.

## Never

- Commit API keys, secrets, real cluster keys, signing material, private
  prompts, personal data, or proprietary datasets. Use synthetic fixtures.
- Log prompts, responses, message content, pairing PINs, or key material.
- Add a second identity or trust store; the data plane reads PAIR's existing
  certificate and pin material.
- Send prompts off the local network by default. When a decision is
  underspecified, choose the option that keeps prompts on the LAN and record it
  in `docs/decisions/NNNN-*.md`.

## Local checks

```bash
make check      # SPDX headers, fmt, clippy, typecheck, lint, contracts
make test       # rust + go + desktop + harness unit tests
```

See `docs/architecture.md` for the layout and how a change travels through the
layers. CI (`.github/workflows/ci.yml`) runs the full matrix on Linux, macOS,
and Windows; `integration` and `soak` run on Linux only.

## Reporting security issues

Follow [SECURITY.md](SECURITY.md). Do not open a public issue.
