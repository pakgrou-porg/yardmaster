// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! Enforce the metrics store's no-content invariant (spec section 4 and 6):
//! every column in the migration is on an explicit allowlist, and no column
//! name contains a content-capture fragment.

use yardmaster_metrics::schema::{allowlist_for, FORBIDDEN_NAME_FRAGMENTS, MIGRATION_V1};

/// Parse `CREATE TABLE <name> ( ... )` blocks out of the migration and return
/// `(table, column)` pairs. Deliberately simple: the migration is hand-written
/// and one column per line.
fn columns(sql: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut table: Option<String> = None;
    let mut depth = 0i32;
    for raw in sql.lines() {
        let line = raw.split("--").next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("create table if not exists ") {
            table = Some(rest.split_whitespace().next().unwrap_or("").to_string());
            depth = line.matches('(').count() as i32 - line.matches(')').count() as i32;
            continue;
        }
        if let Some(rest) = lower.strip_prefix("create table ") {
            table = Some(rest.split_whitespace().next().unwrap_or("").to_string());
            depth = line.matches('(').count() as i32 - line.matches(')').count() as i32;
            continue;
        }
        let Some(t) = table.clone() else { continue };
        depth += line.matches('(').count() as i32;
        depth -= line.matches(')').count() as i32;
        // First token of a column definition line, skipping table constraints.
        let first = line.split([' ', '\t', '(']).next().unwrap_or("");
        let first_lower = first.to_ascii_lowercase();
        let is_constraint = matches!(
            first_lower.as_str(),
            "primary" | "foreign" | "unique" | "check" | "constraint" | ");" | ")" | "insert"
        );
        if !is_constraint && first.chars().all(|c| c.is_ascii_lowercase() || c == '_') && !first.is_empty() {
            out.push((t, first.to_string()));
        }
        if depth <= 0 {
            table = None;
        }
    }
    out
}

#[test]
fn every_column_is_allowlisted() {
    let cols = columns(MIGRATION_V1);
    assert!(cols.len() >= 40, "parser found only {} columns", cols.len());

    for (table, col) in &cols {
        let allow = allowlist_for(table)
            .unwrap_or_else(|| panic!("migration creates unknown table `{table}`"));
        assert!(
            allow.contains(&col.as_str()),
            "`{table}.{col}` is not on the allowlist in src/schema.rs — if this is a \
             legitimate non-content column, add it there and to docs/metrics.md"
        );
    }
}

#[test]
fn no_column_name_signals_content_capture() {
    for (table, col) in columns(MIGRATION_V1) {
        for bad in FORBIDDEN_NAME_FRAGMENTS {
            assert!(
                !col.contains(bad),
                "`{table}.{col}` contains forbidden fragment `{bad}` — the metrics \
                 store must never hold prompt/response content, headers, or addresses"
            );
        }
    }
}

#[test]
fn allowlists_have_no_forbidden_fragments() {
    for table in ["events", "rollups_hourly", "cost_daily"] {
        for col in allowlist_for(table).unwrap() {
            for bad in FORBIDDEN_NAME_FRAGMENTS {
                assert!(!col.contains(bad), "allowlist entry `{table}.{col}` hits `{bad}`");
            }
        }
    }
}
