// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

/**
 * Write one row per request to the Yardmaster metrics store (`node:sqlite`,
 * Node >= 22.5). Same DB file + schema the Console reads. If node:sqlite is
 * unavailable the router still runs — it just doesn't record.
 *
 * INVARIANT (docs/decisions/0012): no prompt/response content, no bodies, no
 * headers, no full client address — only the columns below.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  /* older Node — recording disabled */
}

// The `events` table + indexes from crates/yardmaster-metrics/migrations/0001_init.sql.
const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS events (
  request_id TEXT NOT NULL PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  client_ingress_protocol TEXT NOT NULL,
  client_ingress_port INTEGER NOT NULL,
  client_identity TEXT NOT NULL,
  route TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  tier_decided TEXT NOT NULL,
  decision_reason TEXT NOT NULL,
  rule TEXT,
  candidate_set_size INTEGER NOT NULL,
  node_or_provider TEXT NOT NULL,
  failover_count INTEGER NOT NULL DEFAULT 0,
  engine_kind TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER,
  time_to_first_token_ms INTEGER,
  total_latency_ms INTEGER NOT NULL,
  routing_overhead_ms INTEGER NOT NULL,
  judge_latency_ms INTEGER,
  judge_tokens INTEGER,
  stream INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER NOT NULL,
  error_class TEXT,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  locality TEXT NOT NULL,
  session_id TEXT, agent_id TEXT, step_id TEXT, tier_rule TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts_ms);
CREATE INDEX IF NOT EXISTS events_route_ts ON events (route, ts_ms);
`;

const COLS = [
  "request_id", "ts_ms", "client_ingress_protocol", "client_ingress_port", "client_identity",
  "route", "algorithm", "tier_decided", "decision_reason", "rule", "candidate_set_size",
  "node_or_provider", "failover_count", "engine_kind", "model", "prompt_tokens", "completion_tokens",
  "cached_tokens", "time_to_first_token_ms", "total_latency_ms", "routing_overhead_ms",
  "judge_latency_ms", "judge_tokens", "stream", "http_status", "error_class", "estimated_cost_usd",
  "locality", "session_id", "agent_id", "step_id", "tier_rule",
];

export function openMetrics(dbPath) {
  if (!DatabaseSync || !dbPath) return { record() {}, close() {} };
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {
    /* dir may already exist / be read-only */
  }
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
  } catch (e) {
    console.error(`yardmaster-router: metrics disabled (${e.message})`);
    return { record() {}, close() {} };
  }
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO events (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`,
  );
  return {
    record(row) {
      try {
        stmt.run(...COLS.map((c) => row[c] ?? defaultFor(c)));
      } catch (e) {
        console.error(`yardmaster-router: metrics write failed (${e.message})`);
      }
    },
    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function defaultFor(col) {
  // NOT NULL columns need a value; nullable ones get null.
  const notNullText = {
    client_ingress_protocol: "openai_chat", client_identity: "loopback", route: "default",
    algorithm: "passthrough", tier_decided: "worker", decision_reason: "passthrough",
    node_or_provider: "unknown", engine_kind: "openai_compatible", model: "unknown", locality: "lan",
  };
  const notNullInt = {
    client_ingress_port: 4000, candidate_set_size: 1, failover_count: 0, prompt_tokens: 0,
    completion_tokens: 0, total_latency_ms: 0, routing_overhead_ms: 0, stream: 0, http_status: 0,
  };
  if (col === "ts_ms") return Date.now();
  if (col === "estimated_cost_usd") return 0;
  if (col in notNullText) return notNullText[col];
  if (col in notNullInt) return notNullInt[col];
  return null;
}

export { existsSync };
