// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

// Version is set at build time with -X main.Version=... by scripts/build.sh,
// mirroring the other PAIR workers.
var Version = "0.0.0-dev"

// rpcRequest is a newline-delimited JSON-RPC 2.0 request over stdio.
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(Version)
		return
	}

	// Broker-supervised worker: read newline-delimited JSON-RPC 2.0 from stdin,
	// write notifications (notably lan.endpoint.updated) to stdout.
	//
	// Scaffold: the loop is wired but the browse/probe/classify pipeline and the
	// broker handshake are tracked by a "blocked" issue. It exits cleanly on
	// EOF so the supervisor does not treat startup as a crash.
	cfg := DefaultConfig()
	if err := cfg.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, "yardmaster-lan-scanner: invalid config:", err)
		os.Exit(2)
	}
	_ = NewStore()

	fmt.Fprintf(os.Stderr,
		"yardmaster-lan-scanner %s: scaffold. lan_scan=%v probe_ports=%v interval_s=%d. "+
			"Pipeline tracked in the repo issues labelled 'blocked'.\n",
		Version, cfg.LanScan, cfg.ProbePorts, cfg.IntervalSeconds)

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue // ignore malformed frames rather than crash the worker
		}
		// TODO(blocked): dispatch req.Method (init, discovery.rescan,
		// discovery.promote, shutdown) and emit lan.endpoint.updated.
	}
}
