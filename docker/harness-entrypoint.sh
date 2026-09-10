#!/usr/bin/env sh
# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# The DeepSeek Harness container: runs `dsh web` (loopback only — it executes
# model-generated code and refuses 0.0.0.0) behind a Basic-Auth reverse proxy,
# and auto-configures dsh to send every request through the Yardmaster proxy.
#
#   - self-chowns the DSH_HOME volume, then drops to uid 10001
#   - writes $DSH_HOME/profiles/web/cordis.patch.yml so dsh's default model is
#     served by the Yardmaster proxy (pi-ai "yardmaster" route). A file you
#     wrote yourself (no manage-marker on line 1) is left untouched.
#   - captures dsh's announced URL (with its per-boot launch token) to
#     $DSH_HOME/web-url so the Console can link straight to it
#   - runs docker/auth-proxy.mjs on YM_HARNESS_PROXY_PORT -> 127.0.0.1:PORT,
#     sharing the admin credential the Console sets up on first run
#
# Env: DSH_HOME, YM_HARNESS_PORT (3080), YM_HARNESS_PROXY_PORT (3081),
#      YM_HARNESS_TRUSTED_HOSTS (space-separated host[:port]),
#      YM_HARNESS_UPSTREAM (http://127.0.0.1:11435/v1),
#      YM_HARNESS_MODEL (deepseek-r1:32b),
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
: "${YM_HARNESS_UPSTREAM:=http://127.0.0.1:11435/v1}"
: "${YM_HARNESS_MODEL:=deepseek-r1:32b}"
# pi-ai needs a hand-declared gateway's models listed. If YM_HARNESS_MODELS is
# unset, discover them from the upstream's /v1/models (the router advertises
# every model in yardmaster.toml); fall back to just the default model. Add /
# override explicitly with YM_HARNESS_MODELS="a,b,c".
if [ -z "${YM_HARNESS_MODELS:-}" ]; then
  # Retry: a cold router (just started) may not answer /v1/models on the first try.
  _disc=""
  _i=0
  while [ -z "${_disc}" ] && [ "${_i}" -lt "${YM_HARNESS_DISCOVER_TRIES:-8}" ]; do
    _disc="$(node -e '
      const u=(process.argv[1].replace(/\/+$/,""))+"/models";
      const ac=new AbortController(); const t=setTimeout(()=>ac.abort(),4000);
      fetch(u,{signal:ac.signal}).then(r=>r.json()).then(j=>{
        clearTimeout(t);
        const ids=(j.data||[]).map(m=>m.id).filter(Boolean);
        if(ids.length) process.stdout.write(ids.join(","));
      }).catch(()=>{});
    ' "${YM_HARNESS_UPSTREAM}" 2>/dev/null || true)"
    [ -z "${_disc}" ] && { _i=$((_i + 1)); sleep 3; }
  done
  YM_HARNESS_MODELS="${_disc:-${YM_HARNESS_MODEL}}"
  if [ -n "${_disc}" ]; then
    echo "yardmaster-harness: discovered models from ${YM_HARNESS_UPSTREAM}: ${YM_HARNESS_MODELS}"
  else
    echo "yardmaster-harness: WARNING model discovery from ${YM_HARNESS_UPSTREAM} failed after ${_i} tries — using ${YM_HARNESS_MODEL} only" >&2
  fi
fi
case ",${YM_HARNESS_MODELS}," in
  *",${YM_HARNESS_MODEL},"*) ;;
  *) YM_HARNESS_MODELS="${YM_HARNESS_MODEL},${YM_HARNESS_MODELS}" ;;
esac
: "${YM_AUTH_FILE:=/data/Nvidia Corporation/Personal AI Router/console-auth.json}"

DSH_BIN=/opt/yardmaster/node_modules/@deepseek-ai/dsh/lib/bin.js
AUTH_PROXY=/opt/yardmaster/lib/yardmaster-auth-proxy.mjs
URL_FILE="${DSH_HOME}/web-url"
PROFILE="${DSH_HOME}/profiles/web"
PATCH="${PROFILE}/cordis.patch.yml"
MARKER="# managed by yardmaster-harness-entrypoint"

mkdir -p "${DSH_HOME}"
: > "${URL_FILE}" || true

# --- let dsh scaffold the profile, then write our overlay -----------------
node "${DSH_BIN}" --profile web --dump-default-config >/dev/null 2>&1 || true
mkdir -p "${PROFILE}"

write_overlay=1
if [ -f "${PATCH}" ] && ! head -n 1 "${PATCH}" | grep -qF "${MARKER}"; then
  # Not ours. Keep it only if it holds real patch entries — treat dsh's default
  # boilerplate (comments + an empty "[]" array) and a blank file as overwritable.
  residue="$(sed 's/#.*//' "${PATCH}" | tr -d '[:space:]')"
  if [ -n "${residue}" ] && [ "${residue}" != "[]" ]; then
    write_overlay=0
    echo "yardmaster-harness: keeping your custom ${PATCH}"
  fi
fi
if [ "${write_overlay}" = "1" ]; then
  {
    printf '%s\n' "${MARKER} — delete this line to keep your own edits"
    printf '%s\n' "- id: llm-pi-ai"
    printf '%s\n' "  config:"
    printf '%s\n' "    providers:"
    printf '%s\n' "      yardmaster:"
    printf '%s\n' "        displayName: Yardmaster"
    printf '%s\n' "        baseURL: ${YM_HARNESS_UPSTREAM}"
    printf '%s\n' "        api: openai-completions"
    printf '%s\n' "        models:"
    OLDIFS=$IFS; IFS=','
    for m in ${YM_HARNESS_MODELS}; do
      [ -n "${m}" ] && printf '          - id: %s\n' "${m}"
    done
    IFS=$OLDIFS
    printf '%s\n' "- id: agent-default-model"
    printf '%s\n' "  config:"
    printf '%s\n' "    provider: yardmaster"
    printf '%s\n' "    model: ${YM_HARNESS_MODEL}"
  } > "${PATCH}"
  echo "yardmaster-harness: dsh -> yardmaster proxy ${YM_HARNESS_UPSTREAM} (models: ${YM_HARNESS_MODELS}; default ${YM_HARNESS_MODEL})"

  # Un-managed extension point: your own cordis patch entries (extra plugins,
  # e.g. an MCP server via `- insert:`) appended verbatim after the managed
  # block on every boot. This file is never rewritten. Superseded by the
  # capability-registry regions in ADR-0028.
  USER_PATCH="${PROFILE}/cordis.user.yml"
  if [ -f "${USER_PATCH}" ] && grep -qE '^[[:space:]]*[^#[:space:]]' "${USER_PATCH}"; then
    printf '# --- appended from cordis.user.yml (user-owned) ---\n' >> "${PATCH}"
    cat "${USER_PATCH}" >> "${PATCH}"
    echo "yardmaster-harness: appended ${USER_PATCH}"
  fi
fi

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
    --set)   echo "yardmaster-harness: WARNING dropping unsupported '--set' (see cordis.patch.yml)" >&2; skip_next=1; continue ;;
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
