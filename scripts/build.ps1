# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# Windows build. Mirrors scripts/build.sh. Requires cargo (1.96.1), go (1.25+),
# and pnpm on PATH.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Root = (Get-Location).Path
$BinDir = Join-Path $Root "services\build\bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Write-Host "==> Go services (vendored PAIR tree + yardmaster-lan-scanner)"
Push-Location services
& .\build.bat
Pop-Location
Push-Location services\yardmaster-lan-scanner
& go build -mod=readonly -o (Join-Path $BinDir "yardmaster-lan-scanner.exe") ./...
Pop-Location

Write-Host "==> Rust data plane"
& cargo build --release --locked -p yardmaster-dataplane
Copy-Item "target\release\yardmaster-dataplane.exe" $BinDir

Write-Host "==> DeepSeek Harness packages"
& pnpm install --frozen-lockfile
& pnpm -C packages/dsh-yardmaster build
& pnpm -C packages/dsh-bundle-yardmaster build

Write-Host "==> Staged binaries:"
Get-ChildItem $BinDir

Write-Host "==> Done. Build the desktop app from desktop\ with 'npm start' or 'npm run build'."
