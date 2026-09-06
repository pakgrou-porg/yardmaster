<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

## What and why

<!-- What does this change do, and what observable outcome does it produce?
     Link the issue it closes. -->

## Scope of change

- [ ] Rust crates (`crates/`)
- [ ] Vendored PAIR services (`services/`)
- [ ] Vendored PAIR desktop (`desktop/`)
- [ ] DeepSeek Harness packages (`packages/`)
- [ ] Docs / ADRs (`docs/`)
- [ ] CI / build

## Checklist

- [ ] Every commit is signed off (`git commit -s`) and the DCO trailer matches
      the author.
- [ ] Commits and the PR title follow Conventional Commits.
- [ ] New source files carry an `SPDX-License-Identifier: Apache-2.0` header;
      vendored NVIDIA headers are untouched.
- [ ] No prompt/response content is logged or persisted anywhere.
- [ ] If a routing/egress/discovery default was chosen, it keeps prompts on the
      LAN and there is a `docs/decisions/NNNN-*.md` ADR for it.
- [ ] JSON-RPC changes: producing service, broker relay, every consumer, the
      desktop bridge, tests, and docs are all updated in this PR
      (`npm run service-contracts:check` passes).
- [ ] `services/versions.json` bumped for any changed service binary.
- [ ] Tests added or updated for the behavior changed.
- [ ] `make check` and `make test` pass locally (note any that cannot run in
      your environment).
