<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Migrating from PAIR

Written for someone running PAIR today.

## Zero-config: nothing changes for existing clients

Yardmaster keeps PAIR's process model, pairing protocol, mDNS records, port
numbers, data directory, installers, and every Go worker. The only runtime
change is that one Rust worker, `yardmaster-dataplane`, replaces the
`ollama-proxy` and `lmstudio-proxy` workers and owns ports 11434, 1234, and now
also 4000.

With **no `yardmaster.toml`**:

- `curl http://localhost:11434/api/chat -d '{"model":"qwen4:12b", ...}'` works
  exactly as before. A bare model name that is not a configured route is a
  synthesized `passthrough` route: model selection is a no-op, and placement is
  PAIR's scheduler unchanged (`placement.policy` defaults to `pair_default`,
  which is byte-for-byte PAIR — see
  [decisions/0019](decisions/0019-pair-default-placement-equivalence.md)).
- `/v1/chat/completions` on 1234 works as before.
- `/v1/models` and `/api/tags` fan-out is unchanged (promoted LAN targets and
  unpromoted ones only appear if you turn discovery features on).
- Port 4000 is new: it serves Anthropic Messages `/v1/messages` plus `/health`
  and `/metrics`. Nothing points at it until you choose to.
- LAN discovery of non-paired endpoints is **passive** (mDNS browse only) unless
  you set `[discovery] lan_scan = true`.
- All remote providers are **off**.

If you never write a config file, Yardmaster is PAIR plus an Anthropic endpoint,
a metrics view, and a Discovered view.

### Behavior differences for an existing client

The intended set is **empty**. The one visible addition is the new listener on
port 4000; it serves new endpoints and does not change 11434 / 1234 behavior.
The `lmstudio-proxy:` broker namespace is retired — LM Studio nodes are served by
the data plane's Ollama-native and OpenAI-compatible adapters instead, which is
transparent to clients. If you scripted against the broker's internal
`proxy:set-port` relay directly (not the desktop UI), see the broker changelog:
the method is renamed for the single data-plane worker.

## Adding your first route

1. Create `yardmaster.toml` in PAIR's data directory (the desktop **Routes**
   view writes it for you; it validates via `yardmaster-dataplane dry-run`
   before saving).
2. Start from an example in [routing.md](routing.md). A good first route is
   `plan_execute` from [`../examples/plan-execute.toml`](../examples/plan-execute.toml):
   heavier models for planning turns, cheap local models for execution turns.
3. Point your agent at the route by name:
   - Claude Code: `ANTHROPIC_BASE_URL=http://localhost:4000`,
     `ANTHROPIC_MODEL=plan-execute`.
   - Codex: `OPENAI_BASE_URL=http://localhost:1234/v1`,
     `OPENAI_MODEL=plan-execute`.
4. Watch the **Jobs** view: each row now has "model decided by" (algorithm +
   tier) and "placed on" (node). Click a job for the full decision trace.

## Uninstalling / reverting

Uninstall with PAIR's platform uninstaller. To clear only Yardmaster state
without uninstalling: stop the app, delete `yardmaster.toml` and
`yardmaster-metrics.db` from PAIR's data directory, and (optionally) reinstall
PAIR. Pairing and cluster identity are PAIR's and are untouched.

## Log rotation

Yardmaster logs JSON to stderr under PAIR's conventions; the supervisor captures
it. Configure rotation with the platform tool:

- **Linux**: `systemd-journald` if the desktop runs under a user service, or a
  `logrotate` rule on PAIR's log directory.
- **macOS**: `newsyslog.conf` entry for PAIR's log directory.
- **Windows**: the desktop caps and rolls the captured log file; adjust the size
  in Settings.
