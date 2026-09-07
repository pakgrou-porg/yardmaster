// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"net"
	"time"
)

// Config mirrors the [discovery] table of yardmaster.toml, delivered to this
// worker by the broker at startup (JSON over the init handshake).
type Config struct {
	// LanScan gates all active probing. Default false: mDNS browse only.
	LanScan bool `json:"lan_scan"`
	// Subnets to probe when LanScan is true. CIDR strings. A public range here
	// is a fatal config error (see Validate).
	Subnets []string `json:"subnets"`
	// ProbePorts is the fixed port list. Default [11434, 1234, 8000, 8080, 5000].
	ProbePorts []int `json:"probe_ports"`
	// IntervalSeconds between re-probes. Default 60.
	IntervalSeconds int `json:"interval_s"`
	// DenyHosts are never probed, regardless of Subnets.
	DenyHosts []string `json:"deny_hosts"`
	// ListUnpromoted controls whether unpromoted endpoints appear in the data
	// plane's /v1/models and /api/tags fan-out (annotated). Default false.
	ListUnpromoted bool `json:"list_unpromoted"`
}

// DefaultConfig is the passive, local-by-default configuration.
func DefaultConfig() Config {
	return Config{
		LanScan:         false,
		Subnets:         nil,
		ProbePorts:      []int{11434, 1234, 8000, 8080, 5000},
		IntervalSeconds: 60,
	}
}

// ProbeTimeout is fixed by spec 1.7: 500 ms per GET.
const ProbeTimeout = 500 * time.Millisecond

// probePaths is fixed by spec 1.7: exactly GET /v1/models and GET /api/tags,
// nothing else.
var probePaths = []string{"/v1/models", "/api/tags"}

// ProbeSpec returns the two paths and the per-GET timeout a single host probe
// is allowed to use. The prober (tracked in repo issue #29) must not exceed
// this: two GETs per host per interval, 500 ms each.
func ProbeSpec() (paths []string, timeout time.Duration) {
	return probePaths, ProbeTimeout
}

// Validate rejects a configuration that would probe outside private space.
// A public IP or CIDR in Subnets is fatal (spec section 4).
func (c Config) Validate() error {
	for _, s := range c.Subnets {
		_, ipnet, err := net.ParseCIDR(s)
		if err != nil {
			ip := net.ParseIP(s)
			if ip == nil {
				return fmt.Errorf("discovery.subnets: %q is not an IP or CIDR", s)
			}
			if !isPrivate(ip) {
				return fmt.Errorf("discovery.subnets: %q is not in a private range (RFC 1918 / link-local / ULA)", s)
			}
			continue
		}
		if !isPrivate(ipnet.IP) {
			return fmt.Errorf("discovery.subnets: %q is not a private range (RFC 1918 / link-local / ULA)", s)
		}
	}
	return nil
}

// isPrivate reports whether ip is in an RFC 1918 block, link-local (169.254/16,
// fe80::/10), or IPv6 ULA (fc00::/7). Anything else is "public" and must never
// be probed under any configuration.
func isPrivate(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil {
		switch {
		case ip4[0] == 10:
			return true
		case ip4[0] == 172 && ip4[1]&0xf0 == 16:
			return true
		case ip4[0] == 192 && ip4[1] == 168:
			return true
		case ip4[0] == 169 && ip4[1] == 254: // link-local
			return true
		case ip4[0] == 127: // loopback
			return true
		}
		return false
	}
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return true
	}
	return len(ip) == net.IPv6len && ip[0]&0xfe == 0xfc // fc00::/7 ULA
}
