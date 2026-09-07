#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# Headless Yardmaster node entrypoint. Starts the nvpair-ui-broker control plane,
# which supervises every Go worker plus the data plane. No Electron, no desktop.
#
# The broker speaks JSON-RPC 2.0 on stdin/stdout; with no client attached it
# simply supervises the workers, which serve their network ports. Configuration
# is file-driven: the data plane reads yardmaster.toml from the data dir. Route
# edits from the desktop/TUI are out of scope for a headless container.
set -euo pipefail

BIN=/opt/yardmaster/bin
DATA_DIR="${YM_DATA_DIR:-/data}"
export XDG_CONFIG_HOME="${DATA_DIR}"

# PAIR's per-user data directory (services/shared/appdir): <base>/Nvidia
# Corporation/Personal AI Router, where <base> is $XDG_CONFIG_HOME on Linux.
APP_DIR="${DATA_DIR}/Nvidia Corporation/Personal AI Router"
mkdir -p "${APP_DIR}/cluster" "${APP_DIR}/logs"

# A yardmaster.toml bind-mounted at /config is linked into the location the data
# plane reads. Keeping it read-only at /config means Portainer configs / secrets
# stay the source of truth.
if [ -f /config/yardmaster.toml ]; then
  ln -sf /config/yardmaster.toml "${APP_DIR}/yardmaster.toml"
  echo "yardmaster-entrypoint: using /config/yardmaster.toml"
elif [ -f "${APP_DIR}/yardmaster.toml" ]; then
  echo "yardmaster-entrypoint: using ${APP_DIR}/yardmaster.toml"
else
  echo "yardmaster-entrypoint: no yardmaster.toml — running in PAIR-compatible zero-config mode"
fi

# Optional in-container agent: dsh web on loopback only, in a subshell whose
# environment has every *_API_KEY / *_TOKEN / *_SECRET removed (spec 1.10 /
# ADR-0016). The broker below keeps the full environment so the data plane can
# reach providers.
if [ "${YM_AGENT:-0}" = "1" ] && command -v dsh >/dev/null 2>&1; then
  (
    while IFS='=' read -r _name _; do
      case "${_name^^}" in
        *_API_KEY | *_TOKEN | *_SECRET) unset "${_name}" ;;
      esac
    done < <(env)
    exec dsh web --profile yardmaster-web --no-open
  ) &
  echo "yardmaster-entrypoint: started dsh web on 127.0.0.1:3080 (loopback only)"
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

echo "yardmaster-entrypoint: exec nvpair-ui-broker ${args[*]}"
exec "${BIN}/nvpair-ui-broker" "${args[@]}"
