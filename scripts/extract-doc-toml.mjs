// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0
//
// Write every non-`norun` fenced ```toml block from docs/*.md, plus every
// examples/*.toml, to files under $RUNNER_TEMP (or /tmp) and print their paths,
// one per line. The CI `docs` job feeds these to `yardmaster-dataplane dry-run`
// once that binary exists.

import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DOCS = new URL("../docs/", import.meta.url).pathname;
const EXAMPLES = new URL("../examples/", import.meta.url).pathname;
const OUT = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "doctoml-"));

let n = 0;
function emit(name, body) {
  const p = join(OUT, `${String(++n).padStart(3, "0")}-${name}.toml`);
  writeFileSync(p, body);
  console.log(p);
}

function walk(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) { walk(join(dir, f.name)); continue; }
    if (!f.name.endsWith(".md")) continue;
    const md = readFileSync(join(dir, f.name), "utf8");
    const re = /```toml(,norun)?\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(md))) {
      if (m[1] === ",norun") continue;
      emit(f.name.replace(/\.md$/, ""), m[2]);
    }
  }
}
walk(DOCS);
try {
  for (const f of readdirSync(EXAMPLES)) {
    if (f.endsWith(".toml")) emit(f.replace(/\.toml$/, ""), readFileSync(join(EXAMPLES, f), "utf8"));
  }
} catch { /* no examples/ yet */ }
