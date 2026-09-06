// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! `yardmaster-dataplane` — the one new broker-supervised worker.
//!
//! Owns every inference-facing socket on a node: port 11434 (Ollama-compatible
//! + `/v1/*`), port 1234 (OpenAI-compatible), port 4000 (Anthropic Messages +
//! `/health` + `/metrics`). Each port applies PAIR's two-personalities rule
//! (first byte `0x16` -> mTLS cluster ingress via `yardmaster-cluster-trust`;
//! anything else -> plaintext, refused with 403 unless the peer is loopback).
//!
//! Request pipeline (spec 1.3):
//!   ingress translation -> model selection (Switchyard) -> placement (PAIR,
//!   via yardmaster-placement) -> egress translation -> response/stream
//!   translation back to the client's protocol.
//!
//! A bare unknown model name is a synthesized `passthrough` route so PAIR's
//! zero-config flow is unchanged (ADR-0007).
//!
//! This file is a scaffold. The pipeline, listeners, and limits are tracked by
//! a `blocked` issue linked from README.md.

#![forbid(unsafe_code)]

use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "yardmaster-dataplane", version)]
struct Cli {
    /// Path to yardmaster.toml. If absent, run in PAIR-compatible zero-config mode.
    #[arg(long)]
    config: Option<std::path::PathBuf>,
    /// Broker JSON-RPC on stdio (worker mode). Default when supervised.
    #[arg(long)]
    ipc: bool,
    /// Mirror of Switchyard's --routing-log-file: decision traces as JSON lines.
    #[arg(long)]
    log_routing_file: Option<std::path::PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Validate the config with switchyard-server --dry-run strictness and exit.
    DryRun,
    /// Produce the metrics Markdown report for a date range without the UI.
    Report {
        #[arg(long)]
        from: String,
        #[arg(long)]
        to: String,
        #[arg(long)]
        out: std::path::PathBuf,
    },
}

fn main() {
    let cli = Cli::parse();
    eprintln!(
        "yardmaster-dataplane scaffold: config={:?} ipc={} command={:?}.          Implementation is tracked in the repo issues labelled 'blocked'.",
        cli.config, cli.ipc, cli.command
    );
    std::process::exit(0);
}
