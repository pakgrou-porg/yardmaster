#!/usr/bin/env sh
# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# Runs the DeepSeek Harness Web UI and captures the URL it announces
# (which carries a per-boot launch token) to $DSH_HOME/web-url, so the
# Yardmaster Console can link straight to the current one.
#
# dsh only binds 127.0.0.1 (it executes model-generated code and refuses
# 0.0.0.0). LAN exposure is done by publishing this container's port through the
# namespace owner; dsh's browser-trust fence then needs each non-loopback
# authority in YM_HARNESS_TRUSTED_HOSTS (space-separated host[:port]).
set -eu

: "${DSH_HOME:=/dshhome}"
: "${YM_HARNESS_PORT:=3080}"
: "${YM_HARNESS_TRUSTED_HOSTS:=127.0.0.1:${YM_HARNESS_PORT}}"
DSH_BIN=/opt/yardmaster/node_modules/@deepseek-ai/dsh/lib/bin.js
URL_FILE="${DSH_HOME}/web-url"

mkdir -p "${DSH_HOME}"
: > "${URL_FILE}" || true

set -- web --no-open --host 127.0.0.1 --port "${YM_HARNESS_PORT}"
for h in ${YM_HARNESS_TRUSTED_HOSTS}; do
  case "${h}" in "" | :* ) continue ;; esac   # skip empty / ":3080" from an unset YM_LAN_HOST
  set -- "$@" --trusted-host "${h}"
done
# Extra args from the compose `command:` (e.g. --set ...).
set -- "$@" ${YM_HARNESS_EXTRA_ARGS:-}

echo "yardmaster-harness: node ${DSH_BIN} $*"
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
