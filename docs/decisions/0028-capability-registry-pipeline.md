<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 28. Capability registry pipeline for the Harness model list

- Status: proposed
- Date: 2026-09-09
- Deciders: @pakgrou-porg
- Supersedes the ad-hoc discovery in
  [ADR-0027](0027-interim-node-router.md) (`harness-entrypoint.sh` curling
  `/v1/models` and regenerating `cordis.patch.yml`)

## Context

`harness-entrypoint.sh` currently discovers models from the router's
`/v1/models` at container start and rewrites the `dsh-llm-pi-ai` `models[]` list
and `agent-default-model` in `$DSH_HOME/profiles/web/cordis.patch.yml`, guarded
by a line-1 "managed" marker.

Problems: ownership is file-level (a user can't keep their own patch entries in
that file); no lifecycle (every discovered id is immediately an enabled dsh
model); runs only at boot (a Console config Save doesn't propagate until
restart); no validation (a `[targets.*]` pointing at a dead provider still
appears); the normalized metadata already present in `[targets.*]`
(`context_window`, `tool_calling`, `reasoning`, `vision`) is dropped; a bad
generated fragment crash-loops dsh with only a manual `[]` reset for recovery.

## Decision

Introduce a **capability registry**: a derived, deterministic artifact
recomputed by a pipeline from well-defined inputs. `cordis.patch.yml`'s managed
region becomes a pure render of the registry. Users never edit that region —
their intent is an *input* to the pipeline.

### Inputs (all declarative)

| Input | Source |
| --- | --- |
| declared targets | `yardmaster.toml` `[targets.*]` (+ `[providers.*]`) |
| probed models | each provider's `GET /v1/models` (OpenRouter/vLLM/Ollama) |
| provider metadata | probe payloads (`context_length`, `pricing`, `architecture.modality`, …) |
| operator overrides | `yardmaster.toml` `[harness.overrides.<model-id>]` |
| policy | `yardmaster.toml` `[harness.policy]` |

### The `Capability` record (schema)

```jsonc
{
  "id": "anthropic/claude-sonnet-5",   // the model id a request names
  "target": "or_claude_sonnet5",        // [targets.*] key, if declared
  "provider": "openrouter",
  "locality": "remote",                 // cluster | lan | remote
  "source": "declared" | "probed" | "both",

  // --- lifecycle: three ORTHOGONAL axes, not a linear state machine ---
  "reachability": "discovered" | "validated" | "unreachable",
  "reachability_checked_ms": 1788976000000,
  "policy": "enabled" | "disabled",
  "policy_reason": "allow_remote=false" | "deny glob" | "operator override" | null,
  "rank": 20 | null,                    // lower = more preferred; null = unranked
  "default": false,                     // exactly one true across the registry

  // --- normalized metadata (TOML wins over probe on conflict) ---
  "context_window": 200000,
  "capabilities": { "tools": true, "vision": true, "reasoning": true },
  "pricing_usd_per_mtok": { "in": 3.0, "out": 15.0 } | null,
  "family": "claude" | null,

  "managed_hash": "sha256:…"            // of the rendered dsh entry
}
```

- **"discovered"** = the id exists as a declared target or in a probe list.
- **"validated"** = its provider answered a reachability probe *and* (for probed
  ids) the id is in the live list. An optional, opt-in smoke `POST` upgrades
  confidence but is off by default (it costs money on cloud providers).
- **"unreachable"** = last probe failed. Stays in the registry (so the Console
  can show *why* a model vanished) but is never rendered.
- **"preferred"** is just `rank != null`; **"default"** is the single `default:
  true`. `enabled`/`disabled` is the policy verdict and is independent of
  reachability.

### Pipeline stages (pure, ordered, idempotent)

1. **discover** — union of declared targets + probed models → candidate set.
2. **normalize** — merge TOML metadata with probe metadata into `Capability`;
   **explicit `[targets.*]` / `[harness.overrides]` values always win**.
3. **validate** — reachability probe per provider; set `reachability`.
4. **policy** — apply `[harness.policy]` rules (deny globs, min context,
   locality gates keyed off `[egress]`, rank-by-locality) then
   `[harness.overrides]` (which win) → `policy`, `policy_reason`, `rank`.
5. **select** — resolve exactly one `default`: `[harness.default_model]` if set
   and enabled, else the id of `[routes.default].target`, else the
   highest-ranked enabled `locality = lan|cluster` model.
6. **render** — deterministic dsh fragment: `llm-pi-ai` `providers.yardmaster.models[]`
   from `policy = enabled && reachability = validated`, sorted by `(rank, id)`;
   `agent-default-model` = the default. Stable formatting; compute `managed_hash`.
7. **plan** — diff the rendered fragment vs the current managed region → a list
   of add / remove / change ops. Empty plan ⇒ no write.
8. **apply** — atomic: write `cordis.patch.yml.next`, gate on
   `dsh --profile web --dump-config` exiting 0, then `rename()` into place;
   keep the prior region content as `.lkg` (last-known-good) with its hash.

   **Auto-apply is additive-only.** On a reconcile the pipeline applies, without
   approval:
   - adding a newly-`validated` model to the rendered list;
   - refreshing metadata (`context_window`, `capabilities`, `pricing`) on an
     entry that stays present;
   - any change whose cause is an operator edit to `[harness.overrides]` /
     `[harness.policy]` / `[targets.*]` — the edit *is* the approval, including
     `enabled = false` and a new `default`.

   It does **not** auto-apply, and instead records the op in the pending plan
   for `POST /v1/capabilities/apply` (or the Console P2 button):
   - **removing** a model from the rendered list (including because it went
     `unreachable` or was denied by a *policy rule* rather than an override);
   - changing the `default` for any reason other than an operator edit.

   An `unreachable` model that is still in the rendered list stays there (pi-ai
   only needs it *listed*, not reachable, to boot) and is flagged in
   `/v1/capabilities` until a human approves its removal.
9. **rollback** — if the Harness health probe fails within `apply_probe_window`
   after an apply, restore `.lkg`, quarantine the capability whose op most
   recently changed (mark `policy = disabled`, `policy_reason = "rollback:
   caused dsh boot failure"`), and surface it.

### Ownership rule

`cordis.patch.yml` gets a delimited region:

```yaml
# BEGIN yardmaster-managed  (do not edit; managed by the capability pipeline)
- id: llm-pi-ai
  config: { providers: { yardmaster: { models: [ … ] } } }
- id: agent-default-model
  config: { provider: yardmaster, model: … }
# END yardmaster-managed
```

The pipeline **only ever rewrites bytes between the markers.** Anything outside
is the user's and is never touched. If the file has no region, one is appended.
If the markers are missing but a non-managed `llm-pi-ai` / `agent-default-model`
entry exists, the pipeline treats the file as fully user-owned and does nothing
(logs once).

*Interim (until P1):* `harness-entrypoint.sh` regenerates the whole
`cordis.patch.yml` each boot and appends a user-owned
`cordis.user.yml` (extra plugin entries — MCP servers via `- insert:`, etc.)
verbatim after its block. The region model replaces this.

**Operator overrides never live in the generated file.** They go in
`[harness.overrides.<id>]` (`enabled`, `rank`, `context_window`,
`capabilities.*`, `default = true`) and are read at stage 4/5, so a managed
apply can never clobber them — they are inputs, and inputs win.

### Where it runs

A module in `packages/yardmaster-router` (`src/capabilities.mjs`). The router
already parses `yardmaster.toml`, hot-reloads it, and knows every provider, so
it is the natural host. It:

- exposes `GET /v1/capabilities` (the registry: records + the last plan) and
  `POST /v1/capabilities/reconcile`;
- reconciles on config mtime change, on a probe-list change, and every
  `reconcile_interval_s` (default 60);
- writes the managed region to the shared `yardmaster-harness` volume; dsh's
  profile has `patchReload: "live"`, so the change is picked up without a
  restart.

`harness-entrypoint.sh` stops generating the models block. It only ensures the
profile scaffold exists and tolerates an absent region on first boot.

## Consequences

- Deterministic, inspectable (`/v1/capabilities`, the plan), reconciling.
- Entry-level ownership; user patch entries and managed entries coexist.
- Rollback to last-known-good on a bad apply instead of a crash loop.
- Metadata (`context_window`, capability flags, pricing) flows to dsh and can
  later feed `/v1/models` and routing hints.
- New `[harness.overrides]` / `[harness.policy]` config surface — the validator
  must learn them (`[harness]` is already an allowed top-level key).
- Still interim. When the Rust data plane (#36) lands it either absorbs this
  pipeline or keeps it as the dsh-facing projection layer; the registry schema
  and the config surface are the stable contract.

## Phasing

- **P1** — registry schema + pipeline (stages 1–9), `GET /v1/capabilities` +
  `POST /v1/capabilities/{reconcile,apply}`, marker-region **additive-only
  auto-apply** + pending-plan for destructive ops + `.lkg` rollback,
  `[harness.overrides]` + `[harness.policy]` + validator support, entrypoint
  stops generating. Reconcile on hot-reload + interval.
- **P2** — Console "Capabilities" tab: table (id / provider / locality /
  reachability / policy / rank / default), toggles that write back to
  `[harness.overrides]`, "view plan" / "apply now".
- **P3** — opt-in smoke-test validation; pricing/cost normalization; project the
  enabled set onto the router's `/v1/models`; per-model capability hints on
  responses.
