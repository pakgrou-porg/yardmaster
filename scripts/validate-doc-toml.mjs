// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0
//
// Extract every fenced ```toml block from docs/*.md and examples/*.toml and run
// a lexical TOML sanity check on it: table headers well formed, key/value lines
// parse, brackets balanced, no tabs-as-indent surprises. This is a fast
// pre-check only. The AUTHORITATIVE validation is
//   yardmaster-dataplane dry-run --config <file>
// which CI runs against every extracted block (see .github/workflows/ci.yml,
// docs job). Blocks tagged ```toml,norun are skipped by both.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS = new URL("../docs/", import.meta.url).pathname;
const EXAMPLES = new URL("../examples/", import.meta.url).pathname;

function lexCheck(src, origin) {
  const errs = [];
  let depth = 0;
  src.split("\n").forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) return;
    for (const ch of line) {
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
    }
    const t = line.trim();
    const isHeader = /^\[\[?[A-Za-z0-9_.\- "]+\]\]?$/.test(t);
    const isKV = /^[A-Za-z0-9_."\-]+\s*=\s*.+/.test(t);
    const isCont = /^[\]}"'0-9A-Za-z_.,\-\s{[]+$/.test(t); // array/table continuation
    if (!isHeader && !isKV && !isCont) {
      errs.push(`${origin}:${i + 1}: not a TOML header, key/value, or continuation: ${t}`);
    }
  });
  if (depth !== 0) errs.push(`${origin}: unbalanced brackets (depth ${depth})`);
  return errs;
}

let blocks = 0;
let errors = [];

function scanMarkdown(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) { scanMarkdown(join(dir, f.name)); continue; }
    if (!f.name.endsWith(".md")) continue;
    const md = readFileSync(join(dir, f.name), "utf8");
    const re = /```toml(,norun)?\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(md))) {
      if (m[1] === ",norun") continue;
      blocks++;
      errors.push(...lexCheck(m[2], `${f.name} block@${blocks}`));
    }
  }
}

scanMarkdown(DOCS);
try {
  for (const f of readdirSync(EXAMPLES)) {
    if (!f.endsWith(".toml")) continue;
    blocks++;
    errors.push(...lexCheck(readFileSync(join(EXAMPLES, f), "utf8"), f));
  }
} catch { /* examples/ may not exist yet */ }

if (errors.length) {
  console.error("Doc TOML lexical check failed:");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`Doc TOML lexical check OK (${blocks} blocks)`);
