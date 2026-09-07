<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# @pakgrou-porg/yardmaster-console

A small loopback web console to **configure and observe Yardmaster** and to
reach the **DeepSeek Harness Web UI**, before you deploy a full console over it.
It is intentionally minimal and dependency-light (one dep: `smol-toml`); it does
**not** replace the PAIR desktop or the future Routes/Jobs/Metrics UI
([#32](https://github.com/pakgrou-porg/yardmaster/issues/32)) — it fills the gap
while the Rust data plane is being built. See ADR-0023.

## Tabs

| Tab | What it does | Works today? |
| --- | --- | --- |
| **Config** | Edit `yardmaster.toml`, **Validate** (mirrors `switchyard-server --dry-run` strictness — rejects unknown keys, checks locality/egress/provider-key/HTTPS/discovery rules), **Save**. Prefers the real `yardmaster-dataplane dry-run` when `YM_DATAPLANE_BIN` points at it. | ✅ |
| **Backends** | Parse every `[providers.*]` / `[targets.*]` + `YM_LOCAL_ENGINE_URL`, probe each for liveness, latency, and model inventory. | ✅ (plain HTTP GETs) |
| **Metrics** | Read-only view of `yardmaster-metrics.db` (totals, by route, by node, recent). Empty shell until the data plane writes events. **No prompt/response content is ever stored or shown.** | ⏳ shape now, data later |
| **Agent** | Embeds the DeepSeek Harness Web UI (`YM_AGENT_URL`, default `http://127.0.0.1:3080`). | ✅ when `dsh` is running |

## Run

```bash
# local
YM_CONFIG_PATH=./yardmaster.toml npx @pakgrou-porg/yardmaster-console
# -> http://127.0.0.1:8770

# container (from the repo root)
docker build -f packages/yardmaster-console/Dockerfile -t yardmaster-console:dev .
```

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `YM_CONSOLE_PORT` | `8770` | listen port |
| `YM_CONSOLE_BIND` | `127.0.0.1` (`0.0.0.0` in the image) | bind address — only expose behind your own auth |
| `YM_CONFIG_PATH` | `/config/yardmaster.toml` | primary config location |
| `YM_CONFIG_FALLBACK` | data-dir copy | used when the primary is a read-only mount |
| `YM_METRICS_DB` | data-dir `yardmaster-metrics.db` | metrics store to read |
| `YM_AGENT_URL` | `http://127.0.0.1:3080` | dsh Web UI to embed |
| `YM_LOCAL_ENGINE_URL` | _(unset)_ | a local engine to always probe on the Backends tab |
| `YM_DATAPLANE_BIN` | _(unset)_ | path to `yardmaster-dataplane` for authoritative `dry-run` |

## Tests

```bash
npm test    # node:test — validator, backend prober (vs the integration stub), metrics reader, server
```

## Security

Binds loopback by default. The image binds `0.0.0.0` for container port
publishing — **publish it only to `127.0.0.1` on the host, or put auth in front.**
The console can write `yardmaster.toml`; it never handles API keys (those are env
/ credential-store only) and never reads model prompt/response content.
