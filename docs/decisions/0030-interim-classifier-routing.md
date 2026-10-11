<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 30. Named routes, `random` and `llm_classifier` in the interim router

- Status: accepted
- Date: 2026-10-11
- Deciders: @pakgrou-porg
- Extends [ADR-0027](0027-interim-node-router.md)

## Context

The interim Node router (ADR-0027) runs only `[routes.default]`, as
`passthrough` or failure-based `escalation`. Quality-based routing, where an
easy request goes to a fast model and a hard one to a strong model, waits on
the Rust data plane (#25/#26), which is still a scaffold. The reference
hardware (Strix Halo + two independent GB10s, [ADR-0029](0029-node-topology-and-replicas.md))
has a natural split that benefits from quality-based routing now: a small
judge on the Strix Halo, a replicated mid-size model on the GB10s, and the
largest model on one GB10.

## Decision

Port three pieces of Switchyard's model selection into the interim router,
keeping Switchyard's config schema and semantics so the same `yardmaster.toml`
works unchanged when the Rust data plane lands.

- **Named routes.** A request whose `model` equals a route's `id` runs that
  route. A `[targets.*]` id with the same name wins, so existing model-name
  routing is unchanged.
- **`random`.** A weighted pick over `targets` (`weights`, optional `seed`).
  The chosen target expands to its ADR-0029 replicas.
- **`llm_classifier`, `mode = "capability"`.** A port of libsy's
  `llm_task_classifier`, with:
  - the same system prompt and JSON response schema, copied verbatim under
    Apache-2.0 into `classifier-prompt.mjs`;
  - the same verdict validation (exact four fields, a consistent
    rule/boundary pair, `p_solve` in [0, 1]);
  - the same threshold rule (`base_threshold + steps(boundary) ×
    threshold_step`, with `p_solve ≥ threshold` routing to weak);
  - the same fail-open default: any judge failure or invalid verdict routes
    to `strong_target`.

  The judge sees the opening user instruction and the latest user follow-up,
  as text only.
- **`mode = "escalation"`** is not ported. It degrades to failure-based weak →
  strong, and the validator warns.
- `stage_router`, `plan_execute`, `composite` and `prefill_router` still need
  the data plane. The validator now warns that they only pass through to
  `target`.

Privacy rules carried over:

- A `remote` `classifier_target` is refused unless `judge_egress = "allow"`,
  at both validation and request time.
- Nothing logs or returns the judge's `crux`, which paraphrases the prompt.
- Only `p_solve`, the rule id, the boundary and the threshold appear, in the
  `x-yardmaster-classifier` header and the metrics `rule` column.

## Alternatives considered

- **Wait for the Rust data plane.** It takes several PRs before anything
  routes, and quality-based routing on this hardware is useful now.
- **Write our own judge prompt.** That would diverge from Switchyard's tested
  rubric and make the later swap a behaviour change.
- **Port `stage_router` too.** Its conversation-stage signals are more
  involved and less valuable than a per-request judge here. Revisit if the
  data plane slips further.

## Consequences

- Every request on an `llm_classifier` route pays one judge call
  (`YM_ROUTER_JUDGE_TIMEOUT_MS`, default 10 s, fail-open). The judge must be
  fast and must follow a JSON schema. Small models that can't follow it
  route everything to strong, with `reason=ambiguous` in the header.
- Divergences from libsy:
  - no `recent_turn_window` conversation window;
  - no judge images;
  - no `decision` (System One) judge;
  - no `prompt` override.

  Configs using those keys still validate, and the keys are ignored here.
- Tests: `classifier.test.mjs` covers verdict parsing, the threshold rule,
  fail-open, judge egress, named routes and `random` weighting.
  `validate.test.mjs` covers the new route checks and warnings.
- Superseded wholesale when the Rust data plane runs libsy directly.
