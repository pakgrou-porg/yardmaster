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
# Extra args (must be `dsh web` flags: --host / --port / --trusted-host / --no-open).
# `dsh web` does NOT accept `--set` — that is a top-level `dsh` flag and passing it
# here makes dsh exit ("unknown option '--set'") and the service crash-loops.
# Strip a leading `--set KEY=VAL` (or `--set=KEY=VAL`) pair with a loud warning so
# an old stack file can't take the Harness down. Configure the default model via
# $DSH_HOME/profiles/web/cordis.patch.yml or the in-UI Settings instead.
skip_next=0
for a in ${YM_HARNESS_EXTRA_ARGS:-}; do
  if [ "${skip_next}" = 1 ]; then skip_next=0; continue; fi
  case "${a}" in
    --set)   echo "yardmaster-harness: WARNING dropping unsupported '--set' arg (see cordis.patch.yml)" >&2; skip_next=1; continue ;;
    --set=*) echo "yardmaster-harness: WARNING dropping unsupported '${a}' arg (see cordis.patch.yml)" >&2; continue ;;
  esac
  set -- "$@" "${a}"
done

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
