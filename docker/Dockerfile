# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# Headless Yardmaster node image: the nvpair-ui-broker control plane, every Go
# worker, the Rust data plane, and the LAN scanner — no Electron, no desktop.
#
# Build context is the repo root. Two final targets:
#
#   docker build -f docker/Dockerfile --target runtime-proxy -t yardmaster:proxy .
#       Go workers only (PAIR ollama-proxy + lmstudio-proxy). Builds today.
#       Run it with YM_DATAPLANE_MODE=proxy.
#
#   docker build -f docker/Dockerfile -t yardmaster:dev .
#       Full image, adds the Rust yardmaster-dataplane. The rust-build stage
#       needs the Cargo workspace to compile (issue #36) and build-time network
#       for the pinned Switchyard git deps.

# ---------------------------------------------------------------------------
# Stage — Go: vendored PAIR services + yardmaster-lan-scanner
# ---------------------------------------------------------------------------
FROM golang:1.25-bookworm AS go-build
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
RUN apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY services/ ./services/
# Vendored PAIR build script: reads services/versions.json, builds the workers,
# stages them into services/build/bin/.
RUN cd services && ./build.sh
# Yardmaster's own Go worker (not part of the vendored tree).
RUN mkdir -p /out \
    && cd services/yardmaster-lan-scanner \
    && go build -mod=mod -o /out/yardmaster-lan-scanner ./... \
    && cp /src/services/build/bin/* /out/ 2>/dev/null || true

# ---------------------------------------------------------------------------
# Stage — Rust: yardmaster-dataplane (only used by the `runtime` target)
# ---------------------------------------------------------------------------
FROM rust:1.96-bookworm AS rust-build
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml ./
COPY crates/ ./crates/
COPY patches/ ./patches/
# No Cargo.lock committed yet (issue #36); drop --locked until it lands.
RUN mkdir -p /out \
    && cargo build --release -p yardmaster-dataplane \
    && cp target/release/yardmaster-dataplane /out/yardmaster-dataplane

# ---------------------------------------------------------------------------
# Stage — optional: DeepSeek Harness (dsh) for the in-container agent
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS dsh
RUN npm i -g @deepseek-ai/dsh@0.1.2-rc.1 && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage — runtime-base: everything except the backend binaries
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime-base
LABEL org.opencontainers.image.source="https://github.com/pakgrou-porg/yardmaster"
LABEL org.opencontainers.image.description="Headless Yardmaster node: two-stage LLM router (Switchyard model selection + PAIR node placement)"
LABEL org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini \
      pciutils hwdata \
    && rm -rf /var/lib/apt/lists/*
# ^ pciutils + hwdata give nvpair-node-info a pci.ids DB so it stops logging
#   "No pci-ids DB files found". GPU utilisation/VRAM telemetry still needs
#   nvidia-smi and is unavailable on AMD ROCm (tracked in a repo issue) — this
#   does not affect the engine's own GPU use.

# Non-root by default. The data volume is chowned in the entrypoint.
RUN useradd --system --create-home --uid 10001 --shell /usr/sbin/nologin yardmaster

# dsh (optional): only invoked when YM_AGENT=1.
COPY --from=dsh /usr/local/lib/node_modules /opt/yardmaster/node_modules
COPY --from=dsh /usr/local/bin/node /usr/local/bin/node
# @deepseek-ai/dsh's bin is lib/bin.js (a `#!/usr/bin/env node` script).
RUN ln -s /opt/yardmaster/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh

COPY docker/entrypoint.sh /usr/local/bin/yardmaster-entrypoint
COPY docker/harness-entrypoint.sh /usr/local/bin/yardmaster-harness-entrypoint
RUN chmod +x /usr/local/bin/yardmaster-entrypoint /usr/local/bin/yardmaster-harness-entrypoint

# All backend binaries live together so the broker resolves its siblings by
# default (its --*-path flags default to ./ in the working directory).
WORKDIR /opt/yardmaster/bin

ENV YM_DATA_DIR=/data \
    XDG_CONFIG_HOME=/data \
    NVPAIR_LOG_LEVEL=info \
    YM_DATAPLANE_MODE=proxy \
    YM_LOCAL_ENGINE_URL="" \
    YM_HEALTHCHECK_URL=http://127.0.0.1:11435/api/tags
# ^ the headless ollama-proxy listens on 11435 by default (nothing calls
#   set-port without a UI); the engine sits on 11434. See
#   docs/deployment-docker.md "The port model".
VOLUME ["/data"]

# Ollama ingress, LM Studio / OpenAI ingress, Anthropic + /health + /metrics,
# PAIR node telemetry. Honored only with host networking or explicit -p.
EXPOSE 11434 1234 4000 14318

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS "${YM_HEALTHCHECK_URL}" >/dev/null || exit 1

USER yardmaster
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/yardmaster-entrypoint"]

# ---------------------------------------------------------------------------
# Target — runtime-proxy: Go workers only. Builds and runs today.
# ---------------------------------------------------------------------------
FROM runtime-base AS runtime-proxy
USER root
COPY --from=go-build /out/ /opt/yardmaster/bin/
# nvpair-engine-manager installs/supervises Ollama & LM Studio as HOST processes
# — useless in a container, and while it runs the broker resolves the local
# engine port ONLY from it, so an unmanaged sibling engine is never wired to the
# proxy. Remove it so the broker falls back to probing 127.0.0.1:11434 directly.
RUN rm -f /opt/yardmaster/bin/nvpair-engine-manager \
    && chown -R 10001:10001 /opt/yardmaster/bin
USER yardmaster

# ---------------------------------------------------------------------------
# Target — runtime (default): adds the Rust data plane. Needs issue #36.
# ---------------------------------------------------------------------------
FROM runtime-proxy AS runtime
COPY --from=rust-build --chown=10001:10001 /out/yardmaster-dataplane /opt/yardmaster/bin/
ENV YM_DATAPLANE_MODE=proxy
# ^ still 'proxy' by default until the broker learns --dataplane-path (issue #26);
#   set YM_DATAPLANE_MODE=dataplane once that lands.
