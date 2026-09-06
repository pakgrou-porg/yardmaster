<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Support

Community support for Yardmaster is best-effort. The maintainer does not
guarantee a response or a resolution time.

## Where to get help

- **Questions and ideas:** open a [GitHub Discussion](https://github.com/pakgrou-porg/yardmaster/discussions).
- **Reproducible bugs:** open a [bug report](https://github.com/pakgrou-porg/yardmaster/issues/new?template=bug.yml).
- **Feature proposals:** open a [feature request](https://github.com/pakgrou-porg/yardmaster/issues/new?template=feature.yml).
- **Security vulnerabilities:** follow [SECURITY.md](SECURITY.md). Do not open a
  public issue.

Before opening an issue, check `docs/` and search existing issues. Then include:

- The Yardmaster version or commit.
- The operating system and architecture.
- The inference engine(s), model(s), and whether any remote provider was enabled.
- Reproduction steps.
- Sanitized logs. Yardmaster logs operational metadata only (engine, model, job
  ID, node ID, route, tier); it never logs prompts or responses. Still, redact
  host names and addresses if your network is sensitive.

## Upstream projects

Yardmaster composes NVIDIA NeMo Switchyard and NVIDIA Personal AI Router and
depends on DeepSeek Harness. Bugs that reproduce against those projects on their
own belong in their trackers, not here.
