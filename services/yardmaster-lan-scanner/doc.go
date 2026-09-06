// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

// Command yardmaster-lan-scanner is a broker-supervised Go worker that
// discovers inference endpoints on the LAN that are NOT paired PAIR nodes.
//
// PAIR's nvpair-node-scanner discovers PAIR nodes. This worker complements it:
//
//   - It browses mDNS for _nvpair-node._tcp (unpaired PAIR nodes), _ollama._tcp,
//     _http._tcp with TXT hints, and whatever service types current Ollama,
//     LM Studio, llama.cpp, vLLM, and NIM builds actually advertise.
//
//   - Only when [discovery] lan_scan = true, it probes the configured subnets:
//     the fixed probe_ports list on each host that answered ARP or ICMP in the
//     last interval. A probe is exactly one GET /v1/models and one GET
//     /api/tags with a 500 ms timeout, at most once per host per interval.
//     It never probes outside RFC 1918 / link-local / ULA, never probes a host
//     in the [discovery] deny_hosts list, and rejects a public IP in `subnets`
//     at config load.
//
//   - It classifies each responder as ollama | lmstudio | vllm | llamacpp |
//     nim | openai_compatible from response shape and headers, records the
//     model inventory, measures a lightweight latency, and publishes a
//     lan.endpoint.updated notification keyed by host:port to the broker.
//
//   - It re-probes known endpoints every interval_s, evicts after three
//     consecutive failures, and keeps last-good inventory for display.
//
//   - It NEVER sends inference to a discovered endpoint. Discovery produces
//     candidates; a human promotes one to a locality = "lan" target before it
//     can feed placement.
//
// IPC is newline-delimited JSON-RPC 2.0 over stdio, like every other PAIR
// worker. Logs carry host and port only, at info; no response bodies.
//
// Status: scaffold. The mDNS browse, the bounded prober, classification, and
// the broker notification are tracked by a "blocked" issue linked from
// README.md. This file and its siblings define the shape and the safety
// invariants so consumers can be wired up now.
package main
