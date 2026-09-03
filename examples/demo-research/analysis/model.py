"""Small deterministic risk model referenced by the demo paper.

The constants are intentionally easy to find and edit so the paper editor can
demonstrate repository-aware changes that keep prose, equations, and code in
sync.
"""

from __future__ import annotations

import math


SIGMOID_STEEPNESS = 1.7
TEMPERATURE_OFFSET_C = 0.8
BASELINE_RISK = 0.12
DECISION_THRESHOLD = 0.65
SEED = 17


def risk_score(temperature_anomaly_c: float, rainfall_index: float) -> float:
    """Return a bounded synthetic risk score for one observation."""
    adjusted_temperature = temperature_anomaly_c - TEMPERATURE_OFFSET_C
    linear_signal = (
        SIGMOID_STEEPNESS * adjusted_temperature
        + 0.6 * rainfall_index
        + math.log(BASELINE_RISK / (1.0 - BASELINE_RISK))
    )
    return 1.0 / (1.0 + math.exp(-linear_signal))


def should_intervene(temperature_anomaly_c: float, rainfall_index: float) -> bool:
    """Apply the decision threshold discussed in the manuscript."""
    return risk_score(temperature_anomaly_c, rainfall_index) >= DECISION_THRESHOLD


if __name__ == "__main__":
    example_score = risk_score(temperature_anomaly_c=2.1, rainfall_index=0.4)
    print(f"seed={SEED} score={example_score:.3f} intervene={example_score >= DECISION_THRESHOLD}")
