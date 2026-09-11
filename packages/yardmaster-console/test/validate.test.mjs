// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/validate.mjs";

const ok = (r, msg) => assert.equal(r.ok, true, `${msg}: ${r.errors.join("; ")}`);
const hasErr = (r, sub) =>
  assert.ok(r.errors.some((e) => e.includes(sub)), `expected an error containing "${sub}", got: ${r.errors.join(" | ")}`);

test("a minimal valid config passes", () => {
  ok(validateConfig(`schema_version = 1\n[targets]\n[routes.d]\nid = "d"\ntype = "passthrough"\ntarget = "x"\n[targets.x]\nid = "qwen4:12b"\n`), "minimal");
});

test("the invented [engines.*] schema is rejected with clear errors", () => {
  const r = validateConfig(`
[cluster]
node_id = "yardmaster-primary"

[engines.asus-gemma-util]
type = "openai"
endpoint = "http://10.116.2.56:8002/v1"
models = ["gemma-4-12b-utility"]
`);
  assert.equal(r.ok, false);
  hasErr(r, "unknown top-level key `engines`");
  hasErr(r, "schema_version");
  hasErr(r, "missing `[targets]`");
});

test("the correct translation of that design passes", () => {
  const r = validateConfig(`
schema_version = 1
[egress]
allow_lan = true
allow_remote = false

[providers.asus_util]
kind = "openai_compatible"
base_url = "http://10.116.2.56:8002/v1"

[providers.susa]
kind = "openai_compatible"
base_url = "http://10.116.2.120:8000/v1"

[targets]
[targets.util]
id = "gemma-4-12b-utility"
locality = "lan"
provider = "asus_util"
[targets.qwen_big]
id = "qwen3.6-35b-a3b"
locality = "lan"
provider = "susa"

[routes.default]
id = "auto"
type = "passthrough"
target = "util"
`);
  ok(r, "translated design");
});

test("unknown key inside a table is rejected", () => {
  const r = validateConfig(`schema_version=1\n[targets]\n[targets.x]\nid="m"\nbogus=1\n[routes.r]\nid="r"\ntype="passthrough"\ntarget="x"\n`);
  hasErr(r, "unknown key `targets.x.bogus`");
});

test("remote target without allow_remote is an error", () => {
  const r = validateConfig(`
schema_version=1
[providers.or]
kind="openrouter"
api_key_env="OPENROUTER_API_KEY"
base_url="https://openrouter.ai/api/v1"
[targets]
[targets.o]
id="anthropic/claude-opus-5"
locality="remote"
provider="or"
[routes.r]
id="r"
type="passthrough"
target="o"
`);
  hasErr(r, 'locality = "remote"');
});

test("openrouter needs exactly one of api_key_env / api_key_ref", () => {
  const both = validateConfig(`schema_version=1\n[targets]\n[providers.or]\nkind="openrouter"\nbase_url="https://openrouter.ai/api/v1"\napi_key_env="A"\napi_key_ref="B"\n`);
  hasErr(both, "exactly one of api_key_env or api_key_ref");
  const neither = validateConfig(`schema_version=1\n[targets]\n[providers.or]\nkind="openrouter"\nbase_url="https://openrouter.ai/api/v1"\n`);
  hasErr(neither, "exactly one of api_key_env or api_key_ref");
});

test("http base_url for a keyed provider is rejected; private http for openai_compatible is fine", () => {
  hasErr(
    validateConfig(`schema_version=1\n[targets]\n[providers.v]\nkind="venice"\napi_key_env="X"\nbase_url="http://api.venice.ai/api/v1"\n`),
    "must be https",
  );
  ok(
    validateConfig(`schema_version=1\n[targets]\n[providers.l]\nkind="openai_compatible"\nbase_url="http://192.168.1.9:8000/v1"\n`),
    "private http openai_compatible",
  );
});

test("a literal API key in the file is rejected", () => {
  hasErr(
    validateConfig(`schema_version=1\n[targets]\n[providers.or]\nkind="openrouter"\nbase_url="https://openrouter.ai/api/v1"\napi_key_env="sk-abcdefabcdefabcdefabcdef123456"\n`),
    "literal API key",
  );
});

test("a public discovery subnet is rejected", () => {
  hasErr(
    validateConfig(`schema_version=1\n[targets]\n[discovery]\nlan_scan=true\nsubnets=["8.8.8.0/24"]\n`),
    "not a private range",
  );
});

test("bad ingress port and bad placement policy are rejected", () => {
  hasErr(validateConfig(`schema_version=1\n[targets]\n[ingress]\nollama_port=70000\n`), "1..65535");
  hasErr(validateConfig(`schema_version=1\n[targets]\n[placement]\npolicy="fastest"\n`), "pair_default | warm_first | vram_aware");
});

test("[harness]: a valid registry config (policy + overrides) passes with warnings only for unknown ids", () => {
  const r = validateConfig(`
schema_version = 1
[targets]
[targets.x]
id = "local-model"
[harness]
default_model = "local-model"
[harness.policy]
deny_glob = ["*:free"]
min_context_window = 4096
rank_by_locality = { cluster = 0, lan = 10, remote = 20 }
[harness.overrides."local-model"]
enabled = true
rank = 1
context_window = 8192
default = true
[harness.overrides.capabilities]
capabilities = { tools = true, vision = false }
`);
  ok(r, "valid harness config");
  assert.ok(r.warnings.some((w) => w.includes('"capabilities" matches no')));
});

test("[harness]: unknown keys at every level are rejected", () => {
  const r = validateConfig(`
schema_version = 1
[targets]
[harness]
bogus = 1
[harness.policy]
bogus = 1
[harness.overrides.x]
bogus = 1
`);
  hasErr(r, "unknown key `harness.bogus`");
  hasErr(r, "unknown key `harness.policy.bogus`");
  hasErr(r, 'unknown key `harness.overrides."x".bogus`');
});

test("[harness]: type errors are rejected (enabled, rank, context_window, capabilities.*)", () => {
  const r = validateConfig(`
schema_version = 1
[targets]
[harness.overrides.x]
enabled = "yes"
rank = "1"
context_window = -5
[harness.overrides.x.capabilities]
tools = "yes"
`);
  hasErr(r, "harness.overrides.\"x\".enabled` must be a boolean");
  hasErr(r, "harness.overrides.\"x\".rank` must be a number");
  hasErr(r, "harness.overrides.\"x\".context_window` must be a positive integer");
});

test("[harness]: more than one override with default = true is a warning, not an error", () => {
  const r = validateConfig(`
schema_version = 1
[targets]
[targets.a]
id = "a"
[targets.b]
id = "b"
[harness.overrides.a]
default = true
[harness.overrides.b]
default = true
`);
  ok(r, "multiple defaults is a warning");
  assert.ok(r.warnings.some((w) => w.includes("only the first one wins")));
});
