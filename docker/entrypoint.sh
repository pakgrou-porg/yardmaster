#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# Headless Yardmaster node entrypoint. Starts the nvpair-ui-broker control plane,
# which supervises every Go worker plus the data plane. No Electron, no desktop.
#
# The broker speaks JSON-RPC 2.0 on stdin and treats stdin EOF as "the UI
# disconnected -> shut down". This entrypoint runs it with its stdin on a FIFO
# we hold open for the life of the container (see the bottom of this file), so
# the container needs NO `stdin_open` / `docker -i` and NO TTY. That same
# channel is used to register YM_LOCAL_ENGINE_URL as a manual node so the
# containerised proxy gets a routing target.
#
# Configuration is file-driven: the data plane reads yardmaster.toml from the
# data dir. Route edits from the desktop/TUI are out of scope for a headless
# container.
set -euo pipefail

BIN=/opt/yardmaster/bin
DATA_DIR="${YM_DATA_DIR:-/data}"
export XDG_CONFIG_HOME="${DATA_DIR}"

# PAIR's per-user data directory (services/shared/appdir): <base>/Nvidia
# Corporation/Personal AI Router, where <base> is $XDG_CONFIG_HOME on Linux.
APP_DIR="${DATA_DIR}/Nvidia Corporation/Personal AI Router"
if ! mkdir -p "${APP_DIR}/cluster" "${APP_DIR}/logs" 2>/dev/null; then
  echo "yardmaster-entrypoint: cannot write ${DATA_DIR} (uid $(id -u)). The /data" >&2
  echo "  volume must be chowned to this uid first — run the yardmaster-init" >&2
  echo "  service (\`chown -R 10001:10001 /data\`) before this container." >&2
  exit 1
fi

# A yardmaster.toml bind-mounted at /config is linked into the location the data
# plane reads. Keeping it read-only at /config means Portainer configs / secrets
# stay the source of truth. Clean up a stale link first: if a previous deploy
# had the /config bind mount and this one does not, the volume still holds a
# dangling symlink that makes every write to the config path ENOENT.
if [ -L "${APP_DIR}/yardmaster.toml" ] && [ ! -e "${APP_DIR}/yardmaster.toml" ]; then
  rm -f "${APP_DIR}/yardmaster.toml"
  echo "yardmaster-entrypoint: removed stale dangling yardmaster.toml symlink"
fi
if [ -f /config/yardmaster.toml ]; then
  ln -sf /config/yardmaster.toml "${APP_DIR}/yardmaster.toml"
  echo "yardmaster-entrypoint: using /config/yardmaster.toml"
elif [ -f "${APP_DIR}/yardmaster.toml" ]; then
  echo "yardmaster-entrypoint: using ${APP_DIR}/yardmaster.toml"
else
  echo "yardmaster-entrypoint: no yardmaster.toml — running in PAIR-compatible zero-config mode"
fi

# If a local engine URL is given, wait (bounded) for it to answer before we
# start the broker, so the broker's auto-advertise loop finds it on its first
# pass instead of a cycle later. Also a clear log line for debugging.
if [ -n "${YM_LOCAL_ENGINE_URL:-}" ]; then
  echo "yardmaster-entrypoint: waiting for local engine at ${YM_LOCAL_ENGINE_URL}"
  i=0
  until curl -fsS -m 2 "${YM_LOCAL_ENGINE_URL}/api/tags" >/dev/null 2>&1 \
     || curl -fsS -m 2 "${YM_LOCAL_ENGINE_URL}/v1/models" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      echo "yardmaster-entrypoint: local engine still not answering after ~60s; continuing anyway" >&2
      break
    fi
    sleep 2
  done
  [ "$i" -lt 30 ] && echo "yardmaster-entrypoint: local engine is up"
fi

# Optional in-container agent: dsh web on loopback only, in a subshell whose
# environment has every *_API_KEY / *_TOKEN / *_SECRET removed (spec 1.10 /
# ADR-0016). The broker below keeps the full environment so the data plane can
# reach providers.
#
# The `yardmaster-web` profile needs the (not-yet-published) plugin packages, so
# until then dsh runs with its built-in OpenAI adapter pointed at the Yardmaster
# proxy. Override via YM_AGENT_MODEL (default: a model the local engine has).
if [ "${YM_AGENT:-0}" = "1" ] && command -v dsh >/dev/null 2>&1; then
  YM_AGENT_BASE_URL="${YM_AGENT_BASE_URL:-http://127.0.0.1:11435/v1}"
  YM_AGENT_MODEL="${YM_AGENT_MODEL:-llama3.2:latest}"
  (
    while IFS='=' read -r _name _; do
      case "${_name^^}" in
        *_API_KEY | *_TOKEN | *_SECRET) unset "${_name}" ;;
      esac
    done < <(env)
    if dsh --profile yardmaster-web --help >/dev/null 2>&1; then
      exec dsh web --profile yardmaster-web --no-open
    else
      exec dsh web --no-open \
        --set "llm.openai.baseURL=${YM_AGENT_BASE_URL}" \
        --set "llm.openai.apiKey=sk-yardmaster-noauth" \
        --set "agent.defaultModel.provider=openai" \
        --set "agent.defaultModel.model=${YM_AGENT_MODEL}"
    fi
  ) &
  echo "yardmaster-entrypoint: started dsh web on 127.0.0.1:3080 (model ${YM_AGENT_MODEL} via ${YM_AGENT_BASE_URL})"
fi

# --- broker worker wiring --------------------------------------------------
# The broker's --*-path flags default to ./<name> in the working directory, and
# WORKDIR is $BIN, so most resolve without flags. The inference data-plane path
# is the one that changes with the proxy -> yardmaster-dataplane migration
# (issue #26). Select it with YM_DATAPLANE_MODE.
args=(
  --cluster-dir "${APP_DIR}/cluster"
  --log-level "${NVPAIR_LOG_LEVEL:-info}"
)

case "${YM_DATAPLANE_MODE:-proxy}" in
  proxy)
    # Current tree: PAIR's two proxy workers. Works today.
    args+=( --proxy-path "${BIN}/ollama-proxy" --lmstudio-proxy-path "${BIN}/lmstudio-proxy" )
    ;;
  dataplane)
    # Post-#26: one Rust worker + the LAN scanner. Flags below are the proposed
    # names; update when the broker lands them.
    args+=( --dataplane-path "${BIN}/yardmaster-dataplane" --lan-scanner-path "${BIN}/yardmaster-lan-scanner" )
    ;;
  *)
    echo "yardmaster-entrypoint: unknown YM_DATAPLANE_MODE='${YM_DATAPLANE_MODE}'" >&2
    exit 2
    ;;
esac

echo "yardmaster-entrypoint: nvpair-ui-broker ${args[*]}"

# The broker reads newline-delimited JSON-RPC on stdin and treats stdin EOF as
# "UI disconnected -> shut down". We give it a FIFO we hold open for the life of
# the container (fd 3, read-write so it never EOFs), so the container needs no
# `stdin_open`. We also use that channel to register the local engine as a
# manual node — the only reliable way for the containerised proxy to get a
# routing target (auto-advertise needs the host-only engine-manager).
FIFO="$(mktemp -u /tmp/ym-broker.XXXXXX)"
mkfifo "$FIFO"
exec 3<>"$FIFO"

"${BIN}/nvpair-ui-broker" "${args[@]}" <"$FIFO" &
BROKER=$!
trap 'kill -TERM "$BROKER" 2>/dev/null || true' TERM INT

if [ -n "${YM_LOCAL_ENGINE_URL:-}" ]; then
  ENGINE_HOST="$(printf '%s' "$YM_LOCAL_ENGINE_URL" | sed -E 's#^[a-zA-Z]+://##; s#[:/].*$##')"
  (
    sleep "${YM_MANUAL_NODE_DELAY:-10}"
    printf '{"jsonrpc":"2.0","id":1,"method":"node/add","params":{"address":"%s"}}\n' "$ENGINE_HOST" >&3
    echo "yardmaster-entrypoint: registered local engine as manual node address=${ENGINE_HOST}"
  ) &
fi

wait "$BROKER"
