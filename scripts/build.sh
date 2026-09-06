#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# Build the Go services, the Rust crates, and the desktop app, then stage the
# runtime binaries into services/build/bin/ where PAIR's desktop build expects
# them. Linux/macOS. Windows: scripts/build.ps1.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BIN_DIR="$ROOT/services/build/bin"
mkdir -p "$BIN_DIR"

echo "==> Applying patches/switchyard (if any)"
if compgen -G "patches/switchyard/*.patch" > /dev/null; then
  echo "    (patches are applied via [patch] in Cargo.toml during 'cargo build')"
fi

echo "==> Go services (vendored PAIR tree + yardmaster-lan-scanner)"
( cd services && ./build.sh )

echo "==> yardmaster-lan-scanner"
( cd services/yardmaster-lan-scanner && go build -mod=readonly -o "$BIN_DIR/yardmaster-lan-scanner" ./... )

echo "==> Rust data plane"
cargo build --release --locked -p yardmaster-dataplane
cp "target/release/yardmaster-dataplane" "$BIN_DIR/"

echo "==> DeepSeek Harness packages"
pnpm install --frozen-lockfile
pnpm -C packages/dsh-yardmaster build
pnpm -C packages/dsh-bundle-yardmaster build

echo "==> Staged binaries:"
ls -la "$BIN_DIR"

echo "==> Done. Build the desktop app from desktop/ with 'npm start' or 'npm run build'."
