#!/usr/bin/env sh
# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# The DeepSeek Harness container: runs `dsh web` (loopback only — it executes
# model-generated code and refuses 0.0.0.0) behind a Basic-Auth reverse proxy.
#
#   - self-chowns the DSH_HOME volume, then drops to uid 10001
#   - scaffolds the dsh "web" profile if it doesn't exist yet, then merges in
#     a user-owned $DSH_HOME/profiles/web/cordis.user.yml if present (extra
#     plugin entries — MCP servers via `- insert:`, etc.) exactly once
#   - captures dsh's announced URL (with its per-boot launch token) to
#     $DSH_HOME/web-url so the Console can link straight to it
#   - runs docker/auth-proxy.mjs on YM_HARNESS_PROXY_PORT -> 127.0.0.1:PORT,
#     sharing the admin credential the Console sets up on first run
#
# The Harness's *model list* is no longer written here. The `yardmaster`
# container's capability-registry pipeline (ADR-0028) owns the managed region
# of cordis.patch.yml — it discovers models from yardmaster.toml, writes them,
# and dsh's `patchReload: live` picks up the change with no restart. See
# packages/yardmaster-router/src/capabilities.mjs.
#
# Env: DSH_HOME, YM_HARNESS_PORT (3080), YM_HARNESS_PROXY_PORT (3081),
#      YM_HARNESS_TRUSTED_HOSTS (space-separated host[:port]),
#      YM_HARNESS_EXTRA_ARGS (extra `dsh web` flags only),
#      YM_AUTH_FILE, YM_AUTH_USER/YM_AUTH_PASS (proxy Basic Auth).
set -eu

: "${DSH_HOME:=/dshhome}"

# --- drop privileges once, after fixing volume ownership -------------------
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DSH_HOME}"
  chown -R 10001:10001 "${DSH_HOME}" 2>/dev/null || true
  exec gosu 10001:10001 "$0" "$@"
fi

# gosu keeps the env but not HOME; npm/npx (for MCP servers spawned via `npx -y`)
# need a writable HOME + a cache that persists on the volume.
export HOME=/home/yardmaster
export npm_config_cache="${npm_config_cache:-${DSH_HOME}/.npm-cache}"
mkdir -p "${npm_config_cache}" 2>/dev/null || true

: "${YM_HARNESS_PORT:=3080}"
: "${YM_HARNESS_PROXY_PORT:=3081}"
: "${YM_HARNESS_TRUSTED_HOSTS:=127.0.0.1:${YM_HARNESS_PORT}}"
: "${YM_AUTH_FILE:=/data/Nvidia Corporation/Personal AI Router/console-auth.json}"

DSH_BIN=/opt/yardmaster/node_modules/@deepseek-ai/dsh/lib/bin.js
AUTH_PROXY=/opt/yardmaster/lib/yardmaster-auth-proxy.mjs
URL_FILE="${DSH_HOME}/web-url"
PROFILE="${DSH_HOME}/profiles/web"
PATCH="${PROFILE}/cordis.patch.yml"
USER_PATCH="${PROFILE}/cordis.user.yml"
USER_MARK="# --- appended from cordis.user.yml (user-owned) ---"

mkdir -p "${DSH_HOME}"
: > "${URL_FILE}" || true

# --- scaffold the profile (package.json / cordis.yml / a default cordis.patch.yml) ---
node "${DSH_BIN}" --profile web --dump-default-config >/dev/null 2>&1 || true
mkdir -p "${PROFILE}"

# --- merge in cordis.user.yml exactly once (idempotent across restarts) ---
if [ -f "${USER_PATCH}" ] && grep -qE '^[[:space:]]*[^#[:space:]]' "${USER_PATCH}"; then
  if [ ! -f "${PATCH}" ] || ! grep -qF "${USER_MARK}" "${PATCH}"; then
    # A bare "[]" (dsh's default boilerplate) or a blank file must never
    # survive as a literal prefix — "[]" followed by more block-sequence
    # entries is invalid YAML (the exact crash this project hit by hand).
    residue="$(sed 's/#.*//' "${PATCH}" 2>/dev/null | tr -d '[:space:]')"
    if [ -z "${residue}" ] || [ "${residue}" = "[]" ]; then
      : > "${PATCH}"
    elif [ -s "${PATCH}" ]; then
      printf '\n' >> "${PATCH}"
    fi
    printf '%s\n' "${USER_MARK}" >> "${PATCH}"
    cat "${USER_PATCH}" >> "${PATCH}"
    [ -s "${PATCH}" ] || printf '[]\n' > "${PATCH}"
    echo "yardmaster-harness: merged ${USER_PATCH}"
  fi
fi
# The very first boot, with no user overlay at all: dsh still needs a valid
# top-level array until the capability pipeline writes its region.
[ -s "${PATCH}" ] || printf '[]\n' > "${PATCH}"

# --- build the `dsh web` argv -------------------------------------------
set -- web --no-open --host 127.0.0.1 --port "${YM_HARNESS_PORT}"
for h in ${YM_HARNESS_TRUSTED_HOSTS}; do
  case "${h}" in "" | :* ) continue ;; esac
  set -- "$@" --trusted-host "${h}"
done
# `dsh web` accepts only --host/--port/--trusted-host/--no-open. Drop a stray
# `--set` (a top-level `dsh` flag) so an old stack file can't crash-loop us.
skip_next=0
for a in ${YM_HARNESS_EXTRA_ARGS:-}; do
  if [ "${skip_next}" = 1 ]; then skip_next=0; continue; fi
  case "${a}" in
    --set)   echo "yardmaster-harness: WARNING dropping unsupported '--set' (see cordis.user.yml)" >&2; skip_next=1; continue ;;
    --set=*) echo "yardmaster-harness: WARNING dropping unsupported '${a}'" >&2; continue ;;
  esac
  set -- "$@" "${a}"
done

# --- run dsh + the auth proxy, supervise both -------------------------
echo "yardmaster-harness: node ${DSH_BIN} $*"
(
  node "${DSH_BIN}" "$@" 2>&1 | while IFS= read -r line; do
    printf '%s\n' "${line}"
    case "${line}" in
      *"dsh web: http"*)
        printf '%s\n' "${line##*dsh web: }" > "${URL_FILE}.tmp" 2>/dev/null \
          && mv "${URL_FILE}.tmp" "${URL_FILE}" \
          && echo "yardmaster-harness: wrote ${URL_FILE}"
        ;;
    esac
  done
) &
DSH_PID=$!

# The proxy verifies the shared admin credential: env (YM_AUTH_USER/PASS,
# forwarded here) wins, else the console-auth.json the Console setup writes.
AP_LISTEN_PORT="${YM_HARNESS_PROXY_PORT}" \
AP_TARGET_HOST=127.0.0.1 AP_TARGET_PORT="${YM_HARNESS_PORT}" \
AP_REALM="Yardmaster Harness" AP_AUTH_FILE="${YM_AUTH_FILE}" \
AP_AUTH_USER="${YM_AUTH_USER:-}" AP_AUTH_PASS="${YM_AUTH_PASS:-}" \
  node "${AUTH_PROXY}" &
AP_PID=$!

trap 'kill "${DSH_PID}" "${AP_PID}" 2>/dev/null || true' TERM INT
while kill -0 "${DSH_PID}" 2>/dev/null && kill -0 "${AP_PID}" 2>/dev/null; do
  sleep 2
done
echo "yardmaster-harness: a child exited — stopping the container" >&2
kill "${DSH_PID}" "${AP_PID}" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
