// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * `dsh-bundle-yardmaster` — the bundle glue plugin.
 *
 * The bundle's real work is declarative: `cordis.patch.yml` mounts
 * `@pakgrou-porg/dsh-yardmaster` and repoints `agent-default-model` at the
 * `yardmaster` adapter / `plan-execute` route. This module exists only so the
 * package is a valid Cordis plugin entry; it registers nothing on its own.
 *
 * Profile templates live in `../profiles/`:
 *   - `yardmaster-web`      = dsh-base + dsh-web-app + this bundle  (patchReload: live)
 *   - `yardmaster-headless` = dsh-base + dsh-headless + this bundle (patchReload: startup)
 *
 * Both must boot from `dsh --profile <name> --dump-config` without warnings.
 */

export const name = "dsh-bundle-yardmaster";

export function apply(_ctx: unknown): void {
  // Intentionally empty. See cordis.patch.yml.
}
