// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0
//
// Extract every fenced ```toml block from docs/*.md and every examples/*.toml
// file and run a lexical TOML sanity check: table headers well formed, top-level
// lines are headers or key/value, brackets balanced across the block. Lines
// inside a still-open array or inline table are accepted as continuations.
//
// This is a fast pre-check only. The AUTHORITATIVE validation is
//   yardmaster-dataplane dry-run --config <file>
// which the CI `docs` job runs against every extracted block once the data
// plane binary exists. Blocks fenced as ```toml,norun are skipped by both.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS = new URL("../docs/", import.meta.url).pathname;
const EXAMPLES = new URL("../examples/", import.meta.url).pathname;

function lexCheck(src, origin) {
  const errs = [];
  let depth = 0; // net "[" minus "]" seen so far, ignoring those inside strings
  src.split("\n").forEach((raw, i) => {
    const noComment = raw.replace(/(^|[^\\])#.*$/, "$1").trimEnd();
    const line = noComment.trim();
    if (!line) return;

    const insideAggregate = depth > 0;

    // Count brackets that are not inside a quoted string.
    let inStr = false;
    let strCh = "";
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (inStr) {
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        strCh = ch;
      } else if (ch === "[") depth++;
      else if (ch === "]") depth--;
    }

    if (insideAggregate) return; // continuation line of an open array/inline table

    const isHeader = /^\[\[?\s*[A-Za-z0-9_.\-]+(\.[A-Za-z0-9_.\-]+)*\s*\]\]?$/.test(line)
      || /^\[\[?\s*"[^"]+"\s*(\.\s*[A-Za-z0-9_."\-]+)*\s*\]\]?$/.test(line)
      || /^\[\[?[A-Za-z0-9_.\-". ]+\]\]?$/.test(line);
    const isKV = /^[A-Za-z0-9_."\-]+\s*=\s*.+/.test(line);
    const isCloser = /^[\]}],?$/.test(line);

    if (!isHeader && !isKV && !isCloser) {
      errs.push(`${origin}:${i + 1}: not a TOML header or key/value: ${line}`);
    }
  });
  if (depth !== 0) errs.push(`${origin}: unbalanced brackets (net depth ${depth})`);
  return errs;
}

let blocks = 0;
let errors = [];

function scanMarkdown(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) {
      scanMarkdown(join(dir, f.name));
      continue;
    }
    if (!f.name.endsWith(".md")) continue;
    const md = readFileSync(join(dir, f.name), "utf8");
    const re = /```toml(,norun)?\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(md))) {
      if (m[1] === ",norun") continue;
      blocks++;
      errors.push(...lexCheck(m[2], `${f.name} block#${blocks}`));
    }
  }
}

scanMarkdown(DOCS);

const TOML_FILE_DIRS = [
  EXAMPLES,
  new URL("../deploy/portainer/", import.meta.url).pathname,
];
for (const dir of TOML_FILE_DIRS) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    continue; // directory may not exist yet
  }
  for (const f of entries) {
    if (!/\.toml(\.example)?$/.test(f)) continue;
    blocks++;
    errors.push(...lexCheck(readFileSync(join(dir, f), "utf8"), f));
  }
}

if (errors.length) {
  console.error("Doc TOML lexical check failed:");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`Doc TOML lexical check OK (${blocks} blocks)`);
