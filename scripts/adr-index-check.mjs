// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0
//
// Fail if docs/decisions/ and its README index disagree: every NNNN-*.md file
// (except the template) must have exactly one row in README.md, and every row
// must point at a file that exists.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = new URL("../docs/decisions/", import.meta.url).pathname;
const files = readdirSync(DIR)
  .filter((f) => /^\d{4}-.*\.md$/.test(f) && f !== "0000-template.md")
  .sort();

const index = readFileSync(join(DIR, "README.md"), "utf8");
const linked = new Set(
  [...index.matchAll(/\]\((\d{4}-[a-z0-9-]+\.md)\)/g)]
    .map((m) => m[1])
    .filter((f) => f !== "0000-template.md"),
);

let errors = [];
for (const f of files) if (!linked.has(f)) errors.push(`not indexed in README.md: ${f}`);
for (const l of linked) if (!files.includes(l)) errors.push(`README.md links a missing ADR: ${l}`);

if (errors.length) {
  console.error("ADR index check failed:");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`ADR index OK (${files.length} ADRs)`);
