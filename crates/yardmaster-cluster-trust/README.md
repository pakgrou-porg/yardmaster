<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# yardmaster-cluster-trust

Reads PAIR's existing identity, certificate, and pin-store files and provides an
mTLS acceptor/connector for the data plane. **One identity, one trust store** —
this crate never writes trust material and never creates a second store.

Status: **scaffold**. Implementation tracked in the repo issues (label
`blocked`): "Implement yardmaster-cluster-trust against PAIR cluster-manager
file formats".

- ADR: [docs/decisions/0004-switchyard-as-git-dependency.md](../../docs/decisions/0004-switchyard-as-git-dependency.md)
- Security model: [docs/security.md](../../docs/security.md)
