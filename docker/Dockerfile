# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# Headless Yardmaster node image: the nvpair-ui-broker control plane, every Go
# worker, the Rust data plane, and the LAN scanner — no Electron, no desktop.
#
# Build context is the repo root:
#   docker build -f docker/Dockerfile -t yardmaster:dev .
#
# NOTE: the Rust and Go builds require network access at build time to resolve
# the pinned Switchyard git dependencies and the vendored PAIR module deps.
# Until crates/ compiles cleanly (tracked in issue #36) the `rust-build` stage
# will fail; build with `--target go-only` for a control-plane-only image in the
# meantime (see docs/deployment-docker.md).

# ---------------------------------------------------------------------------
# Stage 1 — Go: vendored PAIR services + yardmaster-lan-scanner
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
RUN cd services/yardmaster-lan-scanner \
    && go build -mod=mod -o /out/yardmaster-lan-scanner ./... \
    && cp /src/services/build/bin/* /out/ 2>/dev/null || true

# ---------------------------------------------------------------------------
# Stage 2 — Rust: yardmaster-dataplane
# ---------------------------------------------------------------------------
FROM rust:1.96-bookworm AS rust-build
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml ./
COPY crates/ ./crates/
COPY patches/ ./patches/
# No Cargo.lock committed yet (issue #36); drop --locked until it lands.
RUN cargo build --release -p yardmaster-dataplane \
    && cp target/release/yardmaster-dataplane /out/yardmaster-dataplane || \
    (mkdir -p /out && echo "rust-build failed — see issue #36" && exit 1)

# ---------------------------------------------------------------------------
# Stage 3 — optional: DeepSeek Harness (dsh) for the in-container agent
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS dsh
RUN npm i -g @deepseek-ai/dsh@0.1.2-rc.1 && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 4 — runtime
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/pakgrou-porg/yardmaster"
LABEL org.opencontainers.image.description="Headless Yardmaster node: two-stage LLM router (Switchyard model selection + PAIR node placement)"
LABEL org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

# Non-root by default. The data volume is chowned in the entrypoint.
RUN useradd --system --create-home --uid 10001 --shell /usr/sbin/nologin yardmaster

# All backend binaries live together so the broker resolves its siblings by
# default (its --*-path flags default to ./ in the working directory).
WORKDIR /opt/yardmaster/bin
COPY --from=go-build   /out/            /opt/yardmaster/bin/
COPY --from=rust-build /out/yardmaster-dataplane /opt/yardmaster/bin/
# dsh (optional): only used when YM_AGENT=1
COPY --from=dsh /usr/local/lib/node_modules /opt/yardmaster/node_modules
COPY --from=dsh /usr/local/bin/node /usr/local/bin/node
RUN ln -s /opt/yardmaster/node_modules/@deepseek-ai/dsh/bin/dsh.mjs /usr/local/bin/dsh || true

COPY docker/entrypoint.sh /usr/local/bin/yardmaster-entrypoint
RUN chmod +x /usr/local/bin/yardmaster-entrypoint

# Data dir (cluster identity, pins, yardmaster.toml, metrics db). Mount a volume here.
ENV YM_DATA_DIR=/data \
    XDG_CONFIG_HOME=/data \
    NVPAIR_LOG_LEVEL=info \
    YM_DATAPLANE_MODE=proxy \
    YM_HEALTHCHECK_URL=http://127.0.0.1:11434/api/tags
VOLUME ["/data"]

# Ollama ingress, LM Studio / OpenAI ingress, Anthropic + /health + /metrics,
# PAIR node telemetry. Honored only with host networking or explicit -p.
EXPOSE 11434 1234 4000 14318

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS "${YM_HEALTHCHECK_URL}" >/dev/null || exit 1

USER yardmaster
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/yardmaster-entrypoint"]
