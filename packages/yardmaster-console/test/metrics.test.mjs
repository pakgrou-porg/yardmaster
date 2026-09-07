// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readMetrics } from "../src/metrics.mjs";

const MIGRATION = fileURLToPath(
  new URL("../../../crates/yardmaster-metrics/migrations/0001_init.sql", import.meta.url),
);

test("empty shell when the DB is absent", () => {
  const m = readMetrics("/no/such/file.db");
  assert.equal(m.available, false);
  assert.deepEqual(m.totals, { requests: 0, tokens: 0, cost_usd: 0, avg_latency_ms: 0, error_rate: 0 });
});

test("reads totals / by_route / by_node from a real schema DB", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ymx-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "yardmaster-metrics.db");

  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(MIGRATION, "utf8"));
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO events (request_id, ts_ms, client_ingress_protocol, client_ingress_port, client_identity,
       route, algorithm, tier_decided, decision_reason, candidate_set_size, node_or_provider, engine_kind,
       model, prompt_tokens, completion_tokens, total_latency_ms, routing_overhead_ms, stream, http_status,
       estimated_cost_usd, locality)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const row = (id, route, node, status, lat, cost) =>
    ins.run(id, now - 1000, "openai_chat", 1234, "loopback", route, "passthrough", "worker", "passthrough",
      1, node, "ollama", "qwen4:12b", 10, 20, lat, 3, 0, status, cost, "lan");
  row("r1", "auto", "framework", 200, 100, 0);
  row("r2", "auto", "framework", 200, 120, 0);
  row("r3", "auto", "susa", 500, 900, 0.002);
  db.close();

  const m = readMetrics(dbPath, { hours: 1 });
  assert.equal(m.available, true);
  assert.equal(m.totals.requests, 3);
  assert.equal(m.totals.tokens, 90);
  assert.ok(Math.abs(m.totals.error_rate - 1 / 3) < 1e-9);

  const auto = m.by_route.find((r) => r.route === "auto");
  assert.equal(auto.requests, 3);

  const susa = m.by_node.find((n) => n.node === "susa");
  assert.equal(susa.requests, 1);
  assert.equal(susa.error_rate, 1);
  assert.equal(m.recent.length, 3);
  // no content columns exist to leak
  assert.ok(!("prompt" in m.recent[0]) && !("content" in m.recent[0]));
});
