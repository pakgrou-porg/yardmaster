<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 1. Record architecture decisions

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Yardmaster merges two upstream systems and adds a third integration. Many design
points are underspecified by the build specification, and the specification
itself requires that each such decision be written down: "Where a decision is
underspecified, choose the option that keeps prompts on the local network by
default, then record the decision in docs/decisions/NNNN-*.md (ADR format, one
file per decision)."

## Decision

Use Architecture Decision Records, one Markdown file per decision, numbered
sequentially from `0001`, in `docs/decisions/`. `0000-template.md` is the
template. `docs/decisions/README.md` is the index and is checked by CI
(`docs` job) to contain one row per `NNNN-*.md` file.

## Alternatives considered

- **A single `DECISIONS.md`** — merges cleanly worse, no per-decision history,
  no stable anchor to cite from code review.
- **Decisions only in commit messages** — not discoverable, not reviewable as a
  set.

## Consequences

Every non-obvious choice gets a citable anchor. The ADR index check fails a PR
that adds an ADR without indexing it, or indexes one that does not exist.
