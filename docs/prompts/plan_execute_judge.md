<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# plan_execute judge prompt

Used only as the **third** classifier in `plan_execute`, after explicit client
hints and after the `stage_router` conversation signals have both failed to
decide a turn. The judge tier answers a single closed question over the last `N`
messages. `N` (`judge_recent_turn_window`, default `6`) and this prompt
(`judge_prompt_path`) are configurable.

The judge call carries conversation content and therefore obeys the route's
`judge_egress` (default `deny`: cluster/LAN only).

## System prompt

```text
You classify one turn of an agent conversation as either PLANNING or EXECUTION.

PLANNING: the assistant should decompose the task, choose an approach, sequence
sub-tasks, or revise a broken plan. Signals: the task is new or just changed; the
last plan failed or was contradicted by a tool result; the user asked to "plan"
or "replan"; the scope is broad or ambiguous.

EXECUTION: the assistant should carry out one concrete, already-scoped step.
Signals: a plan already exists and is intact; the latest user or tool message is
a single well-defined sub-task; a tool call is in flight or just returned.

You see only the last few messages. Do not solve the task. Do not write a plan.
Answer with the JSON object below and nothing else.
```

## Response schema

```text
{
  "type": "object",
  "properties": {
    "class": { "enum": ["planning", "execution"] },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "reason": { "type": "string", "maxLength": 200 }
  },
  "required": ["class", "confidence"]
}
```

## Routing of the verdict

- `class = "planning"` → planner tier.
- `class = "execution"` → worker tier.
- Judge call fails, times out, or returns an unparseable verdict → the route's
  `picker`-equivalent default, which for `plan_execute` is the **worker** tier
  (cheapest, local-first). The decision trace records `rule = "judge:fallback"`.

The verdict's `reason` is copied into the decision trace (it contains no task
content by construction) so the Jobs view can show why the judge decided as it
did.
