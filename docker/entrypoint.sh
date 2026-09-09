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

# Self-heal volume ownership, then drop privileges. The stack runs this service
# as root (`user: "0:0"`) so a first-deploy, root-owned named volume becomes
# writable without a separate init container.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR}"
  chown -R 10001:10001 "${DATA_DIR}" 2>/dev/null || true
  exec gosu 10001:10001 "$0" "$@"
fi

# PAIR's per-user data directory (services/shared/appdir): <base>/Nvidia
# Corporation/Personal AI Router, where <base> is $XDG_CONFIG_HOME on Linux.
APP_DIR="${DATA_DIR}/Nvidia Corporation/Personal AI Router"
if ! mkdir -p "${APP_DIR}/cluster" "${APP_DIR}/logs" 2>/dev/null; then
  echo "yardmaster-entrypoint: cannot write ${DATA_DIR} (uid $(id -u)). Start this" >&2
  echo "  service as root (\`user: \"0:0\"\` in the stack) so it can chown the" >&2
  echo "  volume, or pre-run \`chown -R 10001:10001 /data\` on the volume." >&2
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

if [ -n "${YM_LOCAL_ENGINE_URL:-}" ]; then
  ENGINE_HOST="$(printf '%s' "$YM_LOCAL_ENGINE_URL" | sed -E 's#^[a-zA-Z]+://##; s#[:/].*$##')"
  (
    sleep "${YM_MANUAL_NODE_DELAY:-10}"
    printf '{"jsonrpc":"2.0","id":1,"method":"node/add","params":{"address":"%s"}}\n' "$ENGINE_HOST" >&3
    echo "yardmaster-entrypoint: registered local engine as manual node address=${ENGINE_HOST}"
  ) &
fi

# --- Console (bundled) --------------------------------------------------
# Reads YM_CONSOLE_* / YM_CONFIG_* / YM_METRICS_DB / YM_AUTH_* straight from the
# environment. Auth is ON by default: first hit shows a setup page until an admin
# sets a username/password (persisted under the data dir).
export YM_CONSOLE_BIND="${YM_CONSOLE_BIND:-0.0.0.0}"
export YM_CONSOLE_PORT="${YM_CONSOLE_PORT:-8770}"
node /opt/yardmaster/console/src/server.mjs &
CONSOLE=$!
echo "yardmaster-entrypoint: console on ${YM_CONSOLE_BIND}:${YM_CONSOLE_PORT}"

# --- LAN bridge for the loopback-only inference proxy -----------------
# PAIR's proxy 403s non-loopback plaintext; this in-namespace forwarder makes a
# fresh 127.0.0.1 connection so LAN clients (published :11435) are served. No
# auth: inference clients are not browsers and model access is gated elsewhere.
BRIDGE=""
if [ "${YM_DATAPLANE_MODE:-proxy}" = "proxy" ]; then
  AP_OPEN=1 AP_LISTEN_PORT="${YM_LAN_BRIDGE_PORT:-11430}" \
  AP_TARGET_HOST=127.0.0.1 AP_TARGET_PORT="${YM_PROXY_PORT:-11435}" \
    node /opt/yardmaster/lib/yardmaster-auth-proxy.mjs &
  BRIDGE=$!
  echo "yardmaster-entrypoint: LAN bridge :${YM_LAN_BRIDGE_PORT:-11430} -> 127.0.0.1:${YM_PROXY_PORT:-11435}"
fi

trap 'kill -TERM "$BROKER" "$CONSOLE" ${BRIDGE:-} 2>/dev/null || true' TERM INT

# If any supervised process exits, take the container down so Docker restarts
# the whole unit (state is on the volume, so a restart is cheap).
wait -n "$BROKER" "$CONSOLE" ${BRIDGE:-}
code=$?
echo "yardmaster-entrypoint: a supervised process exited (${code}) — stopping" >&2
kill -TERM "$BROKER" "$CONSOLE" ${BRIDGE:-} 2>/dev/null || true
wait 2>/dev/null || true
exit "${code}"
