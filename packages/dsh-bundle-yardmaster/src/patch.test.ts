// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Row ids the bundle patch is allowed to touch. `agent-default-model` and the
 * inserted `yardmaster` row are the only ones (spec 1.10: "disables nothing
 * else"). If dsh renames a row, the harness-latest CI job catches it; this test
 * keeps the pinned-version patch honest.
 */
const ALLOWED_OVERRIDE_IDS = new Set(["agent-default-model"]);
const EXPECTED_INSERT = { id: "yardmaster", name: "@pakgrou-porg/dsh-yardmaster" };

describe("cordis.patch.yml", () => {
  const doc = yaml.load(readFileSync(here("../cordis.patch.yml"), "utf8")) as unknown[];

  it("is a non-empty YAML sequence", () => {
    expect(Array.isArray(doc)).toBe(true);
    expect(doc.length).toBeGreaterThan(0);
  });

  it("mounts exactly the dsh-yardmaster plugin and nothing else", () => {
    const inserts = doc.flatMap((e) =>
      e && typeof e === "object" && "insert" in e
        ? ((e as { insert: unknown[] }).insert as Record<string, unknown>[])
        : [],
    );
    expect(inserts).toEqual([EXPECTED_INSERT]);
  });

  it("only overrides allow-listed row ids", () => {
    const overrides = doc.filter(
      (e): e is { id: string } =>
        !!e && typeof e === "object" && "id" in e && !("insert" in e),
    );
    for (const o of overrides) expect(ALLOWED_OVERRIDE_IDS.has(o.id)).toBe(true);
  });

  it("points the default model adapter at the yardmaster / plan-execute route", () => {
    const adm = doc.find(
      (e): e is { id: string; config: Record<string, unknown> } =>
        !!e && typeof e === "object" && (e as { id?: string }).id === "agent-default-model",
    );
    expect(adm?.config).toEqual({ provider: "yardmaster", model: "plan-execute" });
  });
});

describe("profile templates", () => {
  for (const [name, mode, reload] of [
    ["yardmaster-web", "@deepseek-ai/dsh-web-app", "live"],
    ["yardmaster-headless", "@deepseek-ai/dsh-headless", "startup"],
  ] as const) {
    it(`${name} stacks base + ${mode} + the bundle`, () => {
      const pkg = JSON.parse(
        readFileSync(here(`../profiles/${name}/package.json`), "utf8"),
      );
      expect(pkg.dsh.profile.bundles).toEqual([
        "@deepseek-ai/dsh-base",
        mode,
        "@pakgrou-porg/dsh-bundle-yardmaster",
      ]);
      expect(pkg.dsh.profile.patchReload).toBe(reload);
    });
  }
});
