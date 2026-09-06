<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 16. The dsh child process inherits an environment with no secrets

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification section 4: "the dsh child process is started only from the desktop
or TUI on explicit user action, binds 127.0.0.1 only, and inherits an
environment with no provider keys (strip *_API_KEY, *_TOKEN, *_SECRET from the
child env; test it)." The plugin's adapter "never holds a provider API key;
Yardmaster holds those."

## Decision

The supervisor spawns `dsh` (`dsh web --profile yardmaster-web --no-open` or
`dsh headless --profile yardmaster-headless <prompt>`) as a non-restarting child
with an environment filtered to drop any variable whose name matches
`*_API_KEY`, `*_TOKEN`, or `*_SECRET` (case-insensitive). The plugin's model
adapter talks to the data plane on loopback (`http://127.0.0.1:1234/v1`, or 4000
for Anthropic-preferring routes); the data plane injects provider credentials,
not the harness. The embedded webview has `nodeIntegration` off,
`contextIsolation` on, `sandbox` on, and a `will-navigate` handler that refuses
any origin other than the harness's loopback URL.

## Alternatives considered

- **Pass keys through so dsh can call providers directly** — puts secrets in a
  process that loads third-party plugins and runs model-generated code; defeats
  the "Yardmaster holds the keys" boundary.

## Consequences

Even a compromised or misbehaving harness plugin cannot read provider keys from
its environment. A desktop test asserts the child env contains no key-like
variables; the telemetry forwarder is covered by the canary-key test.
