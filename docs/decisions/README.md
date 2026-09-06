<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Architecture Decision Records

One file per decision, ADR format, numbered sequentially.
[`0000-template.md`](0000-template.md) is the template. The `docs` CI job checks
that every `NNNN-*.md` file (except the template) has a row in the table below
and that every row points at a file that exists.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | accepted |
| [0002](0002-bootstrap-scope.md) | Initial commit series is a bootstrap; subsystems land behind tracking issues | accepted |
| [0003](0003-vendor-pair-via-subtree.md) | Vendor PAIR services/ and desktop/ via git subtree | accepted |
| [0004](0004-switchyard-as-git-dependency.md) | Consume Switchyard as pinned git dependencies, not a fork | accepted |
| [0005](0005-single-dataplane-worker.md) | One yardmaster-dataplane worker replaces ollama-proxy and lmstudio-proxy | accepted |
| [0006](0006-port-assignments.md) | Ingress port assignments 11434 / 1234 / 4000 | accepted |
| [0007](0007-passthrough-default-route.md) | Unknown model names fall through to a passthrough route | accepted |
| [0008](0008-remote-egress-off-by-default.md) | Remote egress is off by default and requires dual opt-in | accepted |
| [0009](0009-lan-discovery-passive-default.md) | LAN discovery is passive by default; active probing is bounded | accepted |
| [0010](0010-judge-locality.md) | Judge and classifier calls obey the primary request's locality | accepted |
| [0011](0011-provider-trait-and-kinds.md) | One provider trait, four first-class provider kinds | accepted |
| [0012](0012-metrics-store.md) | Metrics store is SQLite (WAL) under PAIR's data dir, with no content columns | accepted |
| [0013](0013-cost-model.md) | Cost model: provider pricing, else config, else notional local cost | accepted |
| [0014](0014-plan-execute-algorithm.md) | plan_execute is a first-class libsy routing algorithm | accepted |
| [0015](0015-dsh-as-dependency.md) | DeepSeek Harness is a pinned npm dependency plus a plugin, never vendored | accepted |
| [0016](0016-dsh-child-env-stripped.md) | The dsh child process inherits an environment with no secrets | accepted |
| [0017](0017-spdx-header-convention.md) | SPDX and copyright header convention for new files | accepted |
| [0018](0018-telemetry-auth-default-plain.md) | Node telemetry stays plaintext by default (telemetry_auth = "plain") | accepted |
| [0019](0019-pair-default-placement-equivalence.md) | placement.policy = "pair_default" is byte-for-byte PAIR scheduler ordering | accepted |
| [0020](0020-repo-owner-and-visibility.md) | Repository is public under pakgrou-porg | accepted |
