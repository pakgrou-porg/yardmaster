// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! Cluster trust for the Yardmaster data plane.
//!
//! Yardmaster does **not** invent an identity or trust store. This crate reads
//! the same on-disk locations that PAIR's `nvpair-cluster-manager` writes
//! (node identity, issued certificate, private key, and the peer pin store) and
//! mirrors their file format, then builds a `rustls` server config (mTLS
//! acceptor) and client config (connector) that trust exactly the currently
//! pinned cluster members.
//!
//! Ingress uses PAIR's two-personalities-on-one-port rule: the first byte
//! `0x16` (TLS `ContentType::handshake`) selects this mTLS path; any other
//! first byte is plaintext and is refused unless the peer is loopback.
//!
//! See docs/decisions/0004 and docs/security.md. Implementation is tracked by a
//! `blocked` issue linked from README.md.

#![forbid(unsafe_code)]

use std::path::PathBuf;

/// Resolved paths to PAIR's trust material inside PAIR's data directory.
#[derive(Debug, Clone)]
pub struct TrustPaths {
    /// Node identity document (JSON), as written by `nvpair-cluster-manager`.
    pub identity: PathBuf,
    /// This node's issued certificate chain (PEM).
    pub cert_chain: PathBuf,
    /// This node's private key (PEM), never logged, never copied.
    pub private_key: PathBuf,
    /// Peer pin store: certificate fingerprints of current cluster members.
    pub pin_store: PathBuf,
}

/// Errors surfaced while loading trust material or completing a handshake.
#[derive(Debug, thiserror::Error)]
pub enum TrustError {
    #[error("trust material not found: {0}")]
    Missing(String),
    #[error("malformed trust material: {0}")]
    Malformed(String),
    #[error("peer certificate is not pinned for any current cluster member")]
    UnpinnedPeer,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// The classification of an accepted connection's first byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Personality {
    /// First byte was 0x16: mTLS cluster ingress.
    ClusterMtls,
    /// Anything else: plaintext. Allowed only from a loopback peer.
    Plaintext,
}

/// Peek the first byte of a stream to choose a personality without consuming it.
pub fn classify_first_byte(first: u8) -> Personality {
    if first == 0x16 { Personality::ClusterMtls } else { Personality::Plaintext }
}
