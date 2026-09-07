<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# tests/integration

Docker Compose harness for Yardmaster. Tracked in
[#34](https://github.com/pakgrou-porg/yardmaster/issues/34).

```bash
docker compose -f tests/integration/docker-compose.yml up --build \
  --abort-on-container-exit --exit-code-from runner
```

## Components

| Service | What |
| --- | --- |
| `engine-a`, `engine-b` | `stub-engine/server.mjs` — a dependency-free OpenAI + Ollama + Anthropic echo engine. Advertises a model list, echoes the last user message (streaming or not), stamps `x-served-by: <node>`, and can fail the first N requests (`FAIL_TIMES` / `FAIL_STATUS`) for failover tests. `engine-b` starts with `FAIL_TIMES=1`. |
| `runner` | `runner/run.test.mjs` — `node:test`, no deps. |
| `yardmaster-a`, `yardmaster-b` | `profile: full` only. Two nodes built from `docker/Dockerfile --target runtime-proxy`. |

## Two phases

- **Phase 1 (default, green today):** the runner checks the stub engines are
  reachable and behave — model lists, echo + node stamping, SSE termination,
  forced-failure recovery. This proves the Compose harness itself.
- **Phase 2 (`test.todo`):** the two-stage-router scenarios from #34 — PIN
  pairing, passthrough placement, `stage_router` escalation to node B, 404
  failover, mTLS handshake rejection, non-loopback 403, `/v1/models` fan-out,
  Anthropic ingress via an OpenAI stub, `allow_remote=false` config rejection,
  and the headless-`dsh` end-to-end (planner on A, workers on B, matching
  `session_id`). These need `yardmaster-dataplane` (#25) and the broker wiring
  (#26). Run them with `--profile full` once those land, and promote each
  `test.todo` to a real assertion.

## Local run without Docker

```bash
NODE_NAME=engine-a PORT=8080 node tests/integration/stub-engine/server.mjs &
NODE_NAME=engine-b PORT=8081 FAIL_TIMES=1 node tests/integration/stub-engine/server.mjs &
ENGINE_A_URL=http://127.0.0.1:8080 ENGINE_B_URL=http://127.0.0.1:8081 \
  node --test --test-force-exit tests/integration/runner/run.test.mjs
```
