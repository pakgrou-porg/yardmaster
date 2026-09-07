// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only view of the Yardmaster metrics store (`yardmaster-metrics.db`,
 * schema from `crates/yardmaster-metrics/migrations/0001_init.sql`). Uses
 * `node:sqlite` (Node >= 22.5). Returns an empty-but-valid shape when the DB
 * does not exist yet, so the console renders before the data plane writes
 * anything. Never reads or exposes content — the schema has none.
 */

import { existsSync } from "node:fs";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const EMPTY = (note) => ({
  available: false,
  note,
  totals: { requests: 0, tokens: 0, cost_usd: 0, avg_latency_ms: 0, error_rate: 0 },
  by_route: [],
  by_node: [],
  recent: [],
});

export function readMetrics(dbPath, { hours = 24 } = {}) {
  if (!DatabaseSync) return EMPTY("node:sqlite unavailable in this runtime");
  if (!dbPath || !existsSync(dbPath)) {
    return EMPTY("no metrics database yet — the data plane writes it once routing is live (#36/#27)");
  }
  const since = Date.now() - hours * 3600_000;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return EMPTY(`could not open ${dbPath}: ${e.message}`);
  }
  try {
    const tot = db
      .prepare(
        `SELECT
           count(*)                               AS requests,
           coalesce(sum(prompt_tokens+completion_tokens),0) AS tokens,
           coalesce(sum(estimated_cost_usd),0)    AS cost_usd,
           coalesce(avg(total_latency_ms),0)      AS avg_latency_ms,
           coalesce(avg(CASE WHEN http_status>=400 THEN 1.0 ELSE 0.0 END),0) AS error_rate
         FROM events WHERE ts_ms >= ?`,
      )
      .get(since);

    const byRoute = db
      .prepare(
        `SELECT route,
                count(*) AS requests,
                coalesce(sum(estimated_cost_usd),0) AS cost_usd,
                coalesce(avg(total_latency_ms),0)   AS avg_latency_ms,
                coalesce(sum(failover_count),0)     AS failovers
         FROM events WHERE ts_ms >= ? GROUP BY route ORDER BY requests DESC LIMIT 50`,
      )
      .all(since);

    const byNode = db
      .prepare(
        `SELECT node_or_provider AS node, engine_kind, locality,
                count(*) AS requests,
                coalesce(avg(total_latency_ms),0) AS avg_latency_ms,
                coalesce(sum(estimated_cost_usd),0) AS cost_usd,
                coalesce(avg(CASE WHEN http_status>=400 THEN 1.0 ELSE 0.0 END),0) AS error_rate
         FROM events WHERE ts_ms >= ? GROUP BY node_or_provider ORDER BY requests DESC LIMIT 50`,
      )
      .all(since);

    const recent = db
      .prepare(
        `SELECT ts_ms, route, algorithm, tier_decided, decision_reason, node_or_provider,
                engine_kind, model, prompt_tokens, completion_tokens, total_latency_ms,
                routing_overhead_ms, http_status, locality, estimated_cost_usd
         FROM events ORDER BY ts_ms DESC LIMIT 100`,
      )
      .all();

    return { available: true, note: null, totals: tot, by_route: byRoute, by_node: byNode, recent };
  } catch (e) {
    return EMPTY(`query failed (schema mismatch?): ${e.message}`);
  } finally {
    db.close();
  }
}
