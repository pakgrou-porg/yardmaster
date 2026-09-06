// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

package main

import "testing"

func TestValidateRejectsPublicSubnet(t *testing.T) {
	cases := []struct {
		name    string
		subnets []string
		wantErr bool
	}{
		{"rfc1918 /24", []string{"192.168.1.0/24"}, false},
		{"10/8", []string{"10.0.0.0/8"}, false},
		{"172.16/12", []string{"172.16.0.0/12"}, false},
		{"link-local", []string{"169.254.0.0/16"}, false},
		{"ula", []string{"fc00::/7"}, false},
		{"public v4", []string{"8.8.8.0/24"}, true},
		{"public single ip", []string{"1.1.1.1"}, true},
		{"public v6", []string{"2606:4700::/32"}, true},
		{"garbage", []string{"not-an-ip"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := DefaultConfig()
			cfg.Subnets = c.subnets
			err := cfg.Validate()
			if (err != nil) != c.wantErr {
				t.Fatalf("Validate(%v) err=%v, wantErr=%v", c.subnets, err, c.wantErr)
			}
		})
	}
}

func TestStoreEvictsAfterThreeMisses(t *testing.T) {
	s := NewStore()
	s.Upsert(Endpoint{Host: "192.168.1.9", Port: 11434, Kind: KindOllama})
	if s.Miss("192.168.1.9", 11434) {
		t.Fatal("evicted after 1 miss")
	}
	if s.Miss("192.168.1.9", 11434) {
		t.Fatal("evicted after 2 misses")
	}
	if !s.Miss("192.168.1.9", 11434) {
		t.Fatal("not evicted after 3 misses")
	}
	if len(s.Snapshot()) != 0 {
		t.Fatal("snapshot not empty after eviction")
	}
}

func TestClassify(t *testing.T) {
	if got := classify("/api/tags", nil, []byte(`{"models":[{"name":"x","digest":"abc"}]}`)); got != KindOllama {
		t.Fatalf("ollama /api/tags classified as %q", got)
	}
	if got := classify("/v1/models", map[string][]string{"Server": {"lmstudio/0.3"}}, []byte(`{}`)); got != KindLMStudio {
		t.Fatalf("lmstudio classified as %q", got)
	}
	if got := classify("/v1/models", nil, []byte(`{"object":"list","data":[]}`)); got != KindOpenAICompatible {
		t.Fatalf("generic classified as %q", got)
	}
}
