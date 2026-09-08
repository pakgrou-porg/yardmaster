# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# The Yardmaster Console: a small loopback web UI. Build from the repo root:
#   docker build -f packages/yardmaster-console/Dockerfile -t yardmaster-console:dev .

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY packages/yardmaster-console/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY packages/yardmaster-console/src ./src
COPY packages/yardmaster-console/public ./public
# The console reads the metrics schema at runtime from this path when present.
COPY crates/yardmaster-metrics/migrations ./crates/yardmaster-metrics/migrations

FROM node:24-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/pakgrou-porg/yardmaster"
LABEL org.opencontainers.image.description="Yardmaster Console — configure and observe Yardmaster, reach the DeepSeek Harness Web UI"
LABEL org.opencontainers.image.licenses="Apache-2.0"
RUN apt-get update && apt-get install -y --no-install-recommends curl tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
# uid 10001 matches the data-plane image so both can write the shared /data volume
# after `yardmaster-init` chowns it.
RUN useradd --system --uid 10001 --create-home yardmaster
USER yardmaster

ENV YM_CONSOLE_PORT=8770 \
    YM_CONSOLE_BIND=0.0.0.0 \
    YM_CONFIG_PATH=/config/yardmaster.toml \
    YM_CONFIG_FALLBACK="/data/Nvidia Corporation/Personal AI Router/yardmaster.toml" \
    YM_METRICS_DB="/data/Nvidia Corporation/Personal AI Router/yardmaster-metrics.db" \
    YM_AGENT_URL=http://127.0.0.1:3080
EXPOSE 8770

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${YM_CONSOLE_PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/server.mjs"]
