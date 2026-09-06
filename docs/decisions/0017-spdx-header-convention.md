<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 17. SPDX and copyright header convention for new files

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification section 2: "Add SPDX headers to every new source file:
SPDX-License-Identifier: Apache-2.0." PAIR uses a two-line SPDX header on every
file and its `scripts/spdx-headers.mjs` checks the tree. Vendored NVIDIA headers
must stay untouched.

## Decision

Every new Yardmaster source or doc file carries, in comment syntax appropriate to
the language:

```
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
```

The user's email address is not placed in file headers or the `NOTICE` file
(name only), though it remains the DCO sign-off / git author identity. Vendored
files under `services/` and `desktop/` keep their existing
`Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES` SPDX headers unchanged. CI
(`rust` and `desktop` jobs) runs an SPDX header check over non-vendored paths.

## Alternatives considered

- **`Copyright (c) 2026 The Yardmaster Authors`** — cleaner for a multi-author
  future but the spec says "your copyright line"; revisit via a superseding ADR
  if the project gains contributors.
- **Include the maintainer email in headers** — needless PII spread across a
  public tree.

## Consequences

A single string to grep for. If authorship broadens, one superseding ADR plus a
tree-wide header rewrite (new files only) changes it.
