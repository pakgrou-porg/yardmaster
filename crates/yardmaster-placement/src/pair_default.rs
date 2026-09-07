// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! `pair_default` ordering — a faithful port of PAIR's `nvpair-job-scheduler`
//! ranking (`services/nvpair-job-scheduler/schedule.go` and `telemetry.go` at
//! the vendored SHA). This is stage two's default policy and must stay
//! **byte-for-byte equivalent** to PAIR's ordering
//! (docs/decisions/0019-pair-default-placement-equivalence.md).
//!
//! What PAIR does, reproduced here:
//!
//! 1. `pending[node]` = count of `queued` + `running` workloads across **both**
//!    engines whose `scheduledOn` is a currently-discovered node. Unplaced work
//!    (`scheduledOn == ""`) and work on unknown nodes count toward nobody.
//! 2. `gpuPressure[node]` is an EWMA (`alpha = 0.35`) of the max GPU
//!    utilisation, mapped to a band with upward/downward hysteresis. Missing,
//!    invalid, or older-than-10s telemetry contributes a neutral pressure of 1.
//! 3. Nodes sort by `pending + gpuPressure` ascending, then `gpuPressure`
//!    ascending, then stable node id ascending. `rank` is the resulting index.
//!
//! This module owns steps 2 and 3 as pure functions; step 1 (counting the live
//! workload catalog) is wired in `yardmaster-placement` proper against
//! `yardmaster-control-client`.

/// Neutral GPU pressure for missing / stale / invalid telemetry
/// (`unknownGPUPressure` in PAIR).
pub const UNKNOWN_GPU_PRESSURE: u8 = 1;

/// EWMA smoothing factor (`gpuEWMAAlpha`).
pub const GPU_EWMA_ALPHA: f64 = 0.35;

/// Telemetry older than this is stale (`gpuTelemetryFreshness`).
pub const GPU_TELEMETRY_FRESHNESS_MS: i64 = 10_000;

/// A node's load inputs after the capability gate. `pending` and `gpu_pressure`
/// are computed exactly as PAIR computes them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct NodeLoad {
    pub id: String,
    pub pending: u32,
    pub gpu_pressure: u8,
}

/// One node's place in the ranking.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Ranked {
    pub id: String,
    pub pending: u32,
    pub gpu_pressure: u8,
    pub rank: u32,
}

/// Order nodes least-loaded-first, matching PAIR's `Manager.rank` sort:
/// `pending + gpuPressure` asc, then `gpuPressure` asc, then id asc.
pub fn pair_default_order(mut nodes: Vec<NodeLoad>) -> Vec<Ranked> {
    nodes.sort_by(|a, b| {
        let la = a.pending as u32 + a.gpu_pressure as u32;
        let lb = b.pending as u32 + b.gpu_pressure as u32;
        la.cmp(&lb)
            .then(a.gpu_pressure.cmp(&b.gpu_pressure))
            .then_with(|| a.id.cmp(&b.id))
    });
    nodes
        .into_iter()
        .enumerate()
        .map(|(i, n)| Ranked {
            id: n.id,
            pending: n.pending,
            gpu_pressure: n.gpu_pressure,
            rank: i as u32,
        })
        .collect()
}

/// Map a (smoothed) utilisation percentage to a pressure band with no
/// hysteresis (`pressureBand`): `<40 => 0`, `<70 => 1`, `<85 => 2`, else `3`.
pub fn pressure_band(utilization: f64) -> u8 {
    if utilization < 40.0 {
        0
    } else if utilization < 70.0 {
        1
    } else if utilization < 85.0 {
        2
    } else {
        3
    }
}

/// Apply PAIR's `pressureWithHysteresis`: step up while `util >= [40,70,85]` for
/// the current band, then step down while `util < [0,35,65,80]`. An
/// out-of-range previous band resets to `pressure_band`.
pub fn pressure_with_hysteresis(utilization: f64, previous: i8) -> u8 {
    if !(0..=3).contains(&previous) {
        return pressure_band(utilization);
    }
    let up = [40.0_f64, 70.0, 85.0];
    let down = [0.0_f64, 35.0, 65.0, 80.0];
    let mut p = previous as usize;
    while p < 3 && utilization >= up[p] {
        p += 1;
    }
    while p > 0 && utilization < down[p] {
        p -= 1;
    }
    p as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors TestRank_ColdStartIDSort.
    #[test]
    fn cold_start_is_a_stable_id_sort() {
        let order = pair_default_order(vec![
            NodeLoad { id: "c".into(), pending: 0, gpu_pressure: 0 },
            NodeLoad { id: "a".into(), pending: 0, gpu_pressure: 0 },
            NodeLoad { id: "b".into(), pending: 0, gpu_pressure: 0 },
        ]);
        assert_eq!(order.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
    }

    // Mirrors TestRank_AscendingByPending: a=2, c=1, b=0 -> b,c,a.
    #[test]
    fn ascending_by_pending() {
        let order = pair_default_order(vec![
            NodeLoad { id: "a".into(), pending: 2, gpu_pressure: 0 },
            NodeLoad { id: "b".into(), pending: 0, gpu_pressure: 0 },
            NodeLoad { id: "c".into(), pending: 1, gpu_pressure: 0 },
        ]);
        assert_eq!(order.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["b", "c", "a"]);
        assert_eq!(order[2].rank, 2);
    }

    // Mirrors TestRank_CombinesPendingAndGPUPressure:
    // b: pending1 pressure0 (1); c: 0+1 (1); d: 0+2 (2); a: 0+3 (3) -> b,c,d,a.
    #[test]
    fn combines_pending_and_gpu_pressure() {
        let order = pair_default_order(vec![
            NodeLoad { id: "a".into(), pending: 0, gpu_pressure: 3 },
            NodeLoad { id: "b".into(), pending: 1, gpu_pressure: 0 },
            NodeLoad { id: "c".into(), pending: 0, gpu_pressure: 1 },
            NodeLoad { id: "d".into(), pending: 0, gpu_pressure: 2 },
        ]);
        assert_eq!(order.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["b", "c", "d", "a"]);
    }

    // Mirrors TestRank_NodeWideMixedEngineSynthetic: a=3, b=1, c=0 -> c,b,a.
    #[test]
    fn node_wide_mixed_engine() {
        let order = pair_default_order(vec![
            NodeLoad { id: "a".into(), pending: 3, gpu_pressure: 0 },
            NodeLoad { id: "b".into(), pending: 1, gpu_pressure: 0 },
            NodeLoad { id: "c".into(), pending: 0, gpu_pressure: 0 },
        ]);
        assert_eq!(order.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["c", "b", "a"]);
    }

    // Mirrors TestPressureBandsAndDownwardHysteresis (band table).
    #[test]
    fn pressure_band_table() {
        for (u, want) in [
            (0.0, 0), (39.999, 0), (40.0, 1), (69.999, 1),
            (70.0, 2), (84.999, 2), (85.0, 3), (100.0, 3),
        ] {
            assert_eq!(pressure_band(u), want, "pressure_band({u})");
        }
    }

    // Mirrors TestPressureBandsAndDownwardHysteresis (hysteresis table).
    #[test]
    fn pressure_hysteresis_table() {
        for (u, prev, want) in [
            (35.0, 1, 1),   // hold one above 35
            (34.9, 1, 0),   // drop one below 35
            (65.0, 2, 2),   // hold two above 65
            (64.9, 2, 1),   // drop two below 65
            (80.0, 3, 3),   // hold three above 80
            (79.9, 3, 2),   // drop three below 80
            (70.0, 1, 2),   // promote at ordinary boundary
            (90.0, 0, 3),   // cross multiple bands upward
            (20.0, 3, 0),   // cross multiple bands downward
        ] {
            assert_eq!(pressure_with_hysteresis(u, prev), want, "hyst({u},{prev})");
        }
    }
}
