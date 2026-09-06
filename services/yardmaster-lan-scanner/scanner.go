// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"time"
)

// EngineKind is the classification of a discovered responder.
type EngineKind string

const (
	KindOllama           EngineKind = "ollama"
	KindLMStudio         EngineKind = "lmstudio"
	KindVLLM             EngineKind = "vllm"
	KindLlamaCPP         EngineKind = "llamacpp"
	KindNIM              EngineKind = "nim"
	KindOpenAICompatible EngineKind = "openai_compatible"
)

// Endpoint is one discovered, non-paired inference endpoint. It is a candidate
// only: it never feeds placement until a human promotes it to a
// locality = "lan" target.
type Endpoint struct {
	Host      string     `json:"host"`
	Port      int        `json:"port"`
	Kind      EngineKind `json:"kind"`
	Models    []string   `json:"models"`
	LatencyMS int64      `json:"latency_ms"`
	LastSeen  time.Time  `json:"last_seen"`
	Misses    int        `json:"-"` // consecutive probe failures; evict at 3
	Promoted  bool       `json:"promoted"`
	FromMDNS  bool       `json:"from_mdns"`
}

// classify infers the engine kind from a /v1/models or /api/tags response body
// and headers. Response-shape only — no service fingerprinting beyond this
// (spec section 9).
func classify(path string, header map[string][]string, body []byte) EngineKind {
	b := strings.ToLower(string(body))
	server := strings.ToLower(strings.Join(header["Server"], " "))

	switch {
	case path == "/api/tags" && strings.Contains(b, "\"models\"") && strings.Contains(b, "\"digest\""):
		return KindOllama
	case strings.Contains(server, "lmstudio") || strings.Contains(b, "lm studio"):
		return KindLMStudio
	case strings.Contains(server, "uvicorn") && strings.Contains(b, "\"object\":\"list\"") && strings.Contains(b, "vllm"):
		return KindVLLM
	case strings.Contains(b, "llama.cpp") || strings.Contains(server, "llama.cpp"):
		return KindLlamaCPP
	case strings.Contains(b, "nvidia") && strings.Contains(b, "nim"):
		return KindNIM
	default:
		return KindOpenAICompatible
	}
}

// Store holds discovered endpoints keyed by "host:port" and applies the
// eviction rule (three consecutive misses) while keeping last-good inventory
// for display.
type Store struct {
	byKey map[string]*Endpoint
}

func NewStore() *Store { return &Store{byKey: map[string]*Endpoint{}} }

func key(host string, port int) string {
	return host + ":" + itoa(port)
}

// Upsert records a successful probe result.
func (s *Store) Upsert(e Endpoint) {
	k := key(e.Host, e.Port)
	e.Misses = 0
	e.LastSeen = time.Now()
	s.byKey[k] = &e
}

// Miss records a failed probe and returns true if the endpoint was evicted.
func (s *Store) Miss(host string, port int) bool {
	k := key(host, port)
	ep, ok := s.byKey[k]
	if !ok {
		return false
	}
	ep.Misses++
	if ep.Misses >= 3 {
		delete(s.byKey, k)
		return true
	}
	return false
}

// Snapshot returns all currently-known endpoints.
func (s *Store) Snapshot() []Endpoint {
	out := make([]Endpoint, 0, len(s.byKey))
	for _, e := range s.byKey {
		out = append(out, *e)
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
