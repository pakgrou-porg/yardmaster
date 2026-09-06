<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 3. Vendor PAIR services/ and desktop/ via git subtree

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.1: "Vendor PAIR's services/ and desktop/ trees into the repo via
git subtree (not submodule) from the recorded SHA, preserving history ... Keep
NVIDIA's SPDX headers and copyright lines on every vendored file untouched."

## Decision

Import `services/` and `desktop/` from
`https://github.com/NVIDIA/Personal-AI-Router` at
`13b68115fa2c9c1d94f1ead1358f8d5a527cfecf` with `git subtree add --prefix`,
one subtree per top-level directory, keeping upstream history. Upstream SPDX and
copyright headers are never modified. Yardmaster changes to these trees are
ordinary commits on top and are kept minimal and upstreamable.

## Alternatives considered

- **Submodule** — explicitly excluded by the specification; also splits the
  build and complicates offline/reproducible builds.
- **Flat copy with squashed history** — loses attribution granularity and makes
  future upstream merges painful.

## Consequences

`git subtree pull` can track upstream later. The repository is larger. CI's
`desktop` unexpected-file check must be kept green as Yardmaster adds files.
