<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Placement equivalence fixtures

These pin `pair_default` to PAIR's `nvpair-job-scheduler` behaviour
(docs/decisions/0019). `tests/pair_equivalence.rs` loads them.

| File | Covers | PAIR source (pinned `13b6811`) |
| --- | --- | --- |
| `ordering.json` | the node sort in `Manager.rank` | `services/nvpair-job-scheduler/schedule.go`, `schedule_test.go` |
| `gpu_pressure.json` | band mapping, hysteresis, EWMA smoothing | `services/nvpair-job-scheduler/telemetry.go`, `telemetry_test.go` |

## The rule, verbatim from PAIR

**Ordering** (`schedule.go` `rankAt`): sort by `pending + gpuPressure` ascending,
then `gpuPressure` ascending, then stable node id ascending. `rank` is the index.
`pending` counts `queued` + `running` workloads from **both** engines whose
`scheduledOn` is a currently-discovered node; unplaced work and work on unknown
nodes count toward nobody.

**GPU pressure** (`telemetry.go`): EWMA `alpha = 0.35` over max GPU utilisation.
Bands (`pressureBand`): `<40 -> 0`, `<70 -> 1`, `<85 -> 2`, else `3`. Downward
hysteresis thresholds (`pressureWithHysteresis` `down`): `[0, 35, 65, 80]`.
Missing / invalid / older-than-10s telemetry -> neutral pressure `1`
(`unknownGPUPressure`). The first fresh sample seeds `EWMA = util`.

## Regenerating

The current fixtures were transcribed by hand from the Go table tests named in
`mirrors:` on each case. To regenerate mechanically after an upstream PAIR
change:

```bash
cd services/nvpair-job-scheduler
# 1. Re-read schedule_test.go / telemetry_test.go for changed expectations.
# 2. Or add a Go helper that dumps rank()/pressureBand() over a matrix to JSON:
go test -run TestDump -tags fixturedump ./... > /tmp/pair-fixtures.json
```

A `fixturedump` Go helper is tracked in
[#24](https://github.com/pakgrou-porg/yardmaster/issues/24); until it exists,
keep this file and the `mirrors:` references in sync with the Go tests by hand,
and treat any diff in `tests/pair_equivalence.rs` as a real behaviour change to
reconcile, not a fixture to "fix".
