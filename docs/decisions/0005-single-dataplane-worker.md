<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 5. One yardmaster-dataplane worker replaces ollama-proxy and lmstudio-proxy

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.1 adds "exactly one new supervised worker", `yardmaster-dataplane`
(Rust), which "replaces PAIR's two Go proxy workers (nvpair-proxy-ollama and
nvpair-proxy-openai, or whatever the current names are in modular-binaries.ts)".
In PAIR at the pinned SHA those workers are `ollama-proxy` (processName `proxy`,
`baseName` `ollama-proxy`) and `lmstudio-proxy` (processName `lmstudio-proxy`).

## Decision

In `desktop/src/shared/constants/modular-binaries.ts` and
`services/versions.json`, remove the `ollama-proxy` and `lmstudio-proxy` entries
and add a single broker-owned worker `yardmaster-dataplane` (`needsFirewallAccess:
true`, `launchOwner: 'broker'`). It owns ports 11434, 1234, and 4000. Also add a
second broker-owned worker `yardmaster-lan-scanner` (`needsFirewallAccess:
false`). The broker passes their resolved paths (`--dataplane-path`,
`--lan-scanner-path`) and never spawns them from Electron.

## Alternatives considered

- **Keep two proxy processes and add the data plane alongside** — three
  processes contending for the same ports; contradicts "exactly one new worker"
  and "replaces".
- **Keep the Go proxies and bolt translation on** — duplicates Switchyard's
  translation layer in Go.

## Consequences

The desktop build's unexpected-file check and firewall-binary list must be
updated in the same change. PAIR's `lmstudio-proxy:` broker namespace is retired;
LM Studio nodes are served by the data plane's Ollama-native and
OpenAI-compatible adapters instead.
