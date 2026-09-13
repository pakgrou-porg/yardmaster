// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * Surgical writer for `[harness.overrides."<model-id>"]` tables (ADR-0028): the
 * Console's Capabilities tab toggles call this instead of round-tripping the
 * whole file through a TOML parser + serializer, which would silently drop
 * every comment in the user's `yardmaster.toml` (the config is meant to be
 * heavily commented — see `yardmaster.toml.example`). This edits only the
 * lines that belong to the target table, leaving every other byte untouched,
 * the same "never rewrite what you don't own" philosophy as the capability
 * pipeline's `cordis.patch.yml` marker region.
 *
 * It is line-based, not a TOML AST editor: it recognizes the table header
 * this module itself writes (`[harness.overrides."<id>"]`, id always
 * double-quoted, backslash/quote-escaped) or a bare unquoted-safe id
 * (`[harness.overrides.some_id]`). A hand-written single-quoted literal
 * string key (`[harness.overrides.'a/b']`) is not recognized as a match, so
 * an upsert against that id appends a second table instead of editing the
 * first — `yardmaster.toml`'s own TOML parser then rejects the duplicate
 * table at validate time (the same gate every write already goes through),
 * so the failure mode is a clear validation error, not silent duplication.
 */

const HEADER_RE = /^\[harness\.overrides\.(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\]\s*$/;
const ANY_HEADER_RE = /^\[.*\]\s*$/;

function unescapeToml(s) {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
function tomlQuotedKey(id) {
  return `"${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function tomlScalar(v) {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  throw new TypeError(`upsertHarnessOverride: unsupported value type for TOML scalar: ${typeof v}`);
}

/**
 * Return `{ start, end }` line indices (end exclusive) of the
 * `[harness.overrides."<id>"]` table in `lines`, or `null` if not present.
 * `start` is the header line itself; `end` is the first following table
 * header (of any name) or `lines.length`.
 */
function findTable(lines, id) {
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER_RE.exec(lines[i]);
    if (!m) continue;
    const found = m[1] !== undefined ? unescapeToml(m[1]) : m[2];
    if (found !== id) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (ANY_HEADER_RE.test(lines[j])) {
        end = j;
        break;
      }
    }
    return { start: i, end };
  }
  return null;
}

/**
 * Set each `key: value` in `patch` inside `[harness.overrides."<id>"]`,
 * creating the table if it doesn't exist yet. Existing `key = value` lines
 * for a patched key are replaced (any trailing inline comment on that line
 * is lost — the one formatting detail this editor does not preserve);
 * unpatched keys and every other line in the file are untouched.
 *
 * @param {string} rawText - the full `yardmaster.toml` contents.
 * @param {string} id - the model id, e.g. `"qwen/qwen3.8-flash"`.
 * @param {Record<string, boolean | number | string>} patch
 * @returns {string} the rewritten file contents.
 */
export function upsertHarnessOverride(rawText, id, patch) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return rawText;

  const hadTrailingNewline = rawText.endsWith("\n");
  const lines = rawText.split("\n");
  if (hadTrailingNewline) lines.pop(); // split() on a trailing \n leaves a "" tail

  const table = findTable(lines, id);
  const keyLineRe = (k) => new RegExp(`^${k}\\s*=`);

  if (table) {
    const body = lines.slice(table.start + 1, table.end);
    const remaining = new Set(keys);
    for (let i = 0; i < body.length; i++) {
      for (const k of keys) {
        if (keyLineRe(k).test(body[i])) {
          body[i] = `${k} = ${tomlScalar(patch[k])}`;
          remaining.delete(k);
          break;
        }
      }
    }
    for (const k of remaining) body.push(`${k} = ${tomlScalar(patch[k])}`);
    lines.splice(table.start + 1, table.end - table.start - 1, ...body);
  } else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(`[harness.overrides.${tomlQuotedKey(id)}]`);
    for (const k of keys) lines.push(`${k} = ${tomlScalar(patch[k])}`);
  }

  return lines.join("\n") + "\n";
}
