<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# yardmaster-dataplane

The single new broker-supervised worker. Owns ports 11434 / 1234 / 4000, the
two-personalities rule, the two-stage pipeline, `/health`, `/metrics`, and the
`yardmaster report` CLI subcommand.

Status: **scaffold** (CLI surface only). Tracked in repo issues (`blocked`):
"Implement yardmaster-dataplane: ingress listeners, two-personalities,
two-stage pipeline, limits".

- ADRs: 0004, 0005, 0006, 0007
- Docs: [docs/architecture.md](../../docs/architecture.md), [docs/routing.md](../../docs/routing.md)
