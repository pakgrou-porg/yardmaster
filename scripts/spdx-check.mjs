// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0
//
// Fail if a non-vendored source file lacks an SPDX-License-Identifier header.
// Vendored trees (services/, desktop/) keep their own upstream headers and are
// checked by PAIR's own tooling, not this script.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "dist", "out", ".pnpm-store",
  "services", "desktop", "assets",
]);
const CHECK_EXT = new Set([
  ".rs", ".go", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".ps1",
  ".toml", ".yml", ".yaml", ".md",
]);
const SKIP_FILES = new Set(["Cargo.lock", "LICENSE", "pnpm-lock.yaml", "package-lock.json"]);

let missing = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(p);
    } else {
      if (SKIP_FILES.has(entry)) continue;
      if (!CHECK_EXT.has(extname(entry))) continue;
      const head = readFileSync(p, "utf8").slice(0, 1024);
      if (!head.includes("SPDX-License-Identifier:")) missing.push(p.replace(ROOT, ""));
    }
  }
}
walk(ROOT);

if (missing.length) {
  console.error("Missing SPDX-License-Identifier header:");
  for (const m of missing) console.error("  " + m);
  process.exit(1);
}
console.log("SPDX headers OK");
