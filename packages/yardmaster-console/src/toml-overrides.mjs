// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * Surgical writers for two `[harness.*]`-adjacent table families (ADR-0028):
 * the Console's Capabilities tab calls these instead of round-tripping the
 * whole file through a TOML parser + serializer, which would silently drop
 * every comment in the user's `yardmaster.toml` (the config is meant to be
 * heavily commented — see `yardmaster.toml.example`). Each edits only the
 * lines that belong to its own table, leaving every other byte untouched,
 * the same "never rewrite what you don't own" philosophy as the capability
 * pipeline's `cordis.patch.yml` marker region.
 *
 * `upsertHarnessOverride` — `[harness.overrides."<model-id>"]`, one per
 * model (enable/disable, rank, default).
 * `generateTargetKey` / `upsertTarget` / `removeTarget` — `[targets.<key>]`,
 * declaring or undeclaring a model as a routable target (ADR-0028 P5). A
 * separate table family from `[harness.overrides]`: an override tunes a
 * model that's already a target; these two functions are what makes it one
 * in the first place.
 *
 * Both are line-based, not a TOML AST editor: they recognize only the table
 * header this module itself writes (double-quoted, backslash/quote-escaped)
 * or a bare unquoted-safe key. A hand-written single-quoted literal string
 * key (e.g. `[harness.overrides.'a/b']`) is not recognized as a match, so an
 * upsert against that id appends a second table instead of editing the
 * first — `yardmaster.toml`'s own TOML parser then rejects the duplicate
 * table at validate time (the same gate every write already goes through),
 * so the failure mode is a clear validation error, not silent duplication.
 */

const HEADER_RE = /^\[harness\.overrides\.(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\]\s*$/;
const TARGET_HEADER_RE = /^\[targets\.(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\]\s*$/;
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

// ---------------------------------------------------------------------------
// [targets.<key>] — declare/undeclare a model as a routable target (P5).
// ---------------------------------------------------------------------------

function linesOf(rawText) {
  const hadTrailingNewline = rawText.endsWith("\n");
  const lines = rawText.split("\n");
  if (hadTrailingNewline) lines.pop(); // split() on a trailing \n leaves a "" tail
  return lines;
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Same shape as `findTable`, against `[targets.*]` instead of
 * `[harness.overrides.*]`.
 */
function findTargetTable(lines, key) {
  for (let i = 0; i < lines.length; i++) {
    const m = TARGET_HEADER_RE.exec(lines[i]);
    if (!m) continue;
    const found = m[1] !== undefined ? unescapeToml(m[1]) : m[2];
    if (found !== key) continue;
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

function existingTargetKeys(lines) {
  const keys = new Set();
  for (const line of lines) {
    const m = TARGET_HEADER_RE.exec(line);
    if (m) keys.add(m[1] !== undefined ? unescapeToml(m[1]) : m[2]);
  }
  return keys;
}

/**
 * A deterministic `[targets.<key>]` table name for newly declaring `id` as
 * a target of `provider`: `slug(provider)_slug(id)` (lowercased, every run
 * of non-`[a-z0-9]` characters collapsed to one `_`, leading/trailing `_`
 * trimmed), deduped against every `[targets.*]` key already in `rawText`
 * (bareword or quoted) by appending `_2`, `_3`, ... . Always a bare TOML
 * key — the character class this produces is a strict subset of TOML's
 * bareword rule, so a raw model id's `/` or `.` can never leak unescaped
 * into the header.
 *
 * @param {string} rawText - the full `yardmaster.toml` contents.
 * @param {string} provider - the `[providers.<name>]` key.
 * @param {string} id - the model id, e.g. `"openai/gpt-5.6-terra"`.
 * @returns {string}
 */
export function generateTargetKey(rawText, provider, id) {
  const used = existingTargetKeys(linesOf(rawText));
  const base = `${slug(provider)}_${slug(id)}`.replace(/^_+|_+$/g, "").replace(/_+/g, "_") || "target";
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  return key;
}

/**
 * Declare or update `[targets.<key>]` with `patch` (typically `{id,
 * provider, locality}`), creating the table if it doesn't exist yet. Same
 * replace-in-place / append semantics as `upsertHarnessOverride`. `key`
 * must already be a bare TOML identifier (see `generateTargetKey`) — this
 * module never quotes a target key itself.
 *
 * @param {string} rawText - the full `yardmaster.toml` contents.
 * @param {string} key - a bare TOML key, e.g. from `generateTargetKey`.
 * @param {Record<string, boolean | number | string>} patch
 * @returns {string} the rewritten file contents.
 */
export function upsertTarget(rawText, key, patch) {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new TypeError(`upsertTarget: key must be a bare TOML identifier, got ${JSON.stringify(key)}`);
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return rawText;

  const lines = linesOf(rawText);
  const table = findTargetTable(lines, key);
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
    lines.push(`[targets.${key}]`);
    for (const k of keys) lines.push(`${k} = ${tomlScalar(patch[k])}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Remove the `[targets.<key>]` table entirely — header through the line
 * before the next table header (or EOF) — leaving every other line,
 * including any `[harness.overrides."<id>"]` for the same model id,
 * untouched (an override for an undeclared id is already a documented
 * no-op in the capability pipeline). Also removes one blank separator line
 * immediately before the table, if present, mirroring exactly what
 * `upsertTarget`'s "create" branch inserts — so a set-then-unset round
 * trip reproduces the original file byte-for-byte. A no-op (returns
 * `rawText` unchanged) if no such table exists.
 *
 * @param {string} rawText
 * @param {string} key
 * @returns {string}
 */
export function removeTarget(rawText, key) {
  const lines = linesOf(rawText);
  const table = findTargetTable(lines, key);
  if (!table) return rawText;
  lines.splice(table.start, table.end - table.start);
  if (table.start > 0 && lines[table.start - 1] === "") lines.splice(table.start - 1, 1);
  return lines.join("\n") + "\n";
}
