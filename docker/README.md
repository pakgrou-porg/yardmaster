<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# docker/

Headless container build for a Yardmaster node.

| File | Purpose |
| --- | --- |
| `Dockerfile` | multi-stage: Go workers + Rust data plane + optional dsh → `debian:bookworm-slim` runtime |
| `entrypoint.sh` | starts `nvpair-ui-broker` (no Electron); wires worker paths; optional `dsh`; strips agent secrets |

Stacks and full instructions: [`../deploy/portainer/`](../deploy/portainer/) and
[`../docs/deployment-docker.md`](../docs/deployment-docker.md).

```bash
# build from the repo root
docker build -f docker/Dockerfile -t yardmaster:dev .

# run a single node (host networking; Linux)
docker run -d --name yardmaster --network host \
  -v yardmaster-data:/data \
  -e NVPAIR_LOG_LEVEL=info \
  yardmaster:dev
```

Status: the `rust-build` stage fails until the workspace compiles
([#36](https://github.com/pakgrou-porg/yardmaster/issues/36)); the container
otherwise runs in `YM_DATAPLANE_MODE=proxy`. See
[#46](https://github.com/pakgrou-porg/yardmaster/issues/46).
