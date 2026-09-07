// SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
// SPDX-License-Identifier: Apache-2.0

//! PAIR scheduler equivalence: drive `pair_default_order` and the GPU-pressure
//! functions with fixtures extracted from `nvpair-job-scheduler`'s Go tests and
//! assert the same results. See `tests/fixtures/README.md`.

use serde::Deserialize;
use yardmaster_placement::{
    pair_default_order, pressure_band, pressure_with_hysteresis, NodeLoad,
};

#[derive(Deserialize)]
struct OrderingFixture {
    cases: Vec<OrderingCase>,
}

#[derive(Deserialize)]
struct OrderingCase {
    name: String,
    nodes: Vec<NodeLoad>,
    expected_order: Vec<String>,
}

#[derive(Deserialize)]
struct PressureFixture {
    band: Vec<BandCase>,
    hysteresis: Vec<HystCase>,
    ewma: EwmaFixture,
}

#[derive(Deserialize)]
struct BandCase {
    util: f64,
    want: u8,
}

#[derive(Deserialize)]
struct HystCase {
    name: String,
    util: f64,
    previous: i8,
    want: u8,
}

#[derive(Deserialize)]
struct EwmaFixture {
    alpha: f64,
    sequence: Vec<EwmaStep>,
}

#[derive(Deserialize)]
struct EwmaStep {
    util: f64,
    ewma_after: f64,
    pressure_after: u8,
}

#[test]
fn ordering_matches_pair() {
    let raw = include_str!("fixtures/ordering.json");
    let fixture: OrderingFixture = serde_json::from_str(raw).expect("ordering.json parses");
    for case in fixture.cases {
        let got: Vec<String> = pair_default_order(case.nodes.clone())
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(got, case.expected_order, "case {}", case.name);

        // rank is a dense 0..n index in emitted order.
        let ranked = pair_default_order(case.nodes);
        for (i, r) in ranked.iter().enumerate() {
            assert_eq!(r.rank as usize, i, "case {} rank density", case.name);
        }
    }
}

#[test]
fn gpu_pressure_matches_pair() {
    let raw = include_str!("fixtures/gpu_pressure.json");
    let fixture: PressureFixture = serde_json::from_str(raw).expect("gpu_pressure.json parses");

    for c in fixture.band {
        assert_eq!(pressure_band(c.util), c.want, "band({})", c.util);
    }
    for c in fixture.hysteresis {
        assert_eq!(
            pressure_with_hysteresis(c.util, c.previous),
            c.want,
            "hysteresis case {}",
            c.name
        );
    }

    // Reproduce the EWMA smoothing: first fresh sample seeds EWMA = util; each
    // subsequent fresh sample folds in with `alpha`.
    let alpha = fixture.ewma.alpha;
    let mut ewma: Option<f64> = None;
    let mut pressure: u8 = 0;
    for step in fixture.ewma.sequence {
        ewma = Some(match ewma {
            None => step.util,
            Some(prev) => alpha * step.util + (1.0 - alpha) * prev,
        });
        let e = ewma.unwrap();
        assert!(
            (e - step.ewma_after).abs() < 1e-6,
            "ewma after util={} => {e}, want {}",
            step.util,
            step.ewma_after
        );
        pressure = pressure_with_hysteresis(e, pressure as i8);
        assert_eq!(pressure, step.pressure_after, "pressure after util={}", step.util);
    }
}
