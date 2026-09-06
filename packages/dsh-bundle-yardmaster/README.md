<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# @pakgrou-porg/dsh-bundle-yardmaster

A DeepSeek Harness **bundle** plus the two Yardmaster **profile templates**.

## The bundle

`cordis.patch.yml` (declared via `dsh.bundle.patch`) does exactly two things and
disables nothing else:

1. `insert` — mounts `@pakgrou-porg/dsh-yardmaster`.
2. override `agent-default-model` — `provider: yardmaster`, `model: plan-execute`.

`dsh-web-config.reference.yml` is the captured `dsh --profile web --dump-config`
for the pinned dsh version and is the authoritative list of rows the patch may
target. `src/patch.test.ts` asserts the patch touches only those rows.

## The profiles

| Profile | `dsh.profile.bundles` | `patchReload` |
| --- | --- | --- |
| `yardmaster-web` | `dsh-base`, `dsh-web-app`, `dsh-bundle-yardmaster` | `live` |
| `yardmaster-headless` | `dsh-base`, `dsh-headless`, `dsh-bundle-yardmaster` | `startup` |

Both must boot from `dsh --profile <name> --dump-config` without warnings
(checked by the `harness` CI job).

## Use

Desktop app: **Start Harness** runs `dsh web --profile yardmaster-web --no-open`.
TUI: an action runs `dsh headless --profile yardmaster-headless "<task>"`.

Install the plugin into an existing dsh instead of using the profile:

```
dsh plugin --profile web add @pakgrou-porg/dsh-yardmaster
```

## Status

**Scaffold.** The patch, profile manifests, and their tests are real and pass.
The bundle glue plugin is a no-op entry by design. See
[../dsh-yardmaster/COMPATIBILITY.md](../dsh-yardmaster/COMPATIBILITY.md).
