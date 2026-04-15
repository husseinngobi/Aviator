from collections import defaultdict
from dataclasses import dataclass, field


class CongestionManager:
    """Controller utilities for congestion and safety decisions."""

    @staticmethod
    def check_safety_cutoff(current_value, set_point):
        """
        Return True when the current value exceeds the safety set point.

        Args:
            current_value: Live measured value from telemetry.
            set_point: Maximum safe operating threshold.

        Returns:
            bool: True means terminate/cutoff signal should trigger.
        """
        return float(current_value) > float(set_point)


def _normalize_reconciliation_result(predicted, actual):
    return reconcile_telemetry(predicted, actual)


@dataclass
class RiskRegistry:
    """Tracks packet-size risk signatures and returns standby allocation for blacklisted sizes."""

    blacklist: set[int] = field(default_factory=set)
    seen_count: dict[int, int] = field(default_factory=lambda: defaultdict(int))
    halt_count: dict[int, int] = field(default_factory=lambda: defaultdict(int))

    halt_value_threshold: float = 1.2
    min_halt_events: int = 2
    min_halt_ratio: float = 0.6
    null_allocation: float = 0.0

    def observe(self, packet_size, value):
        """Ingest one observation and update blacklist membership for the packet size."""
        size = int(packet_size)
        metric = float(value)

        self.seen_count[size] += 1
        if metric < self.halt_value_threshold:
            self.halt_count[size] += 1

        halts = self.halt_count[size]
        total = self.seen_count[size]
        ratio = (halts / total) if total else 0.0

        if halts >= self.min_halt_events and ratio >= self.min_halt_ratio:
            self.blacklist.add(size)

    def is_blacklisted(self, packet_size):
        return int(packet_size) in self.blacklist

    def allocation_for_packet(self, packet_size, normal_allocation):
        """Return standby allocation for blacklisted signatures; otherwise return normal allocation."""
        if self.is_blacklisted(packet_size):
            return self.null_allocation
        return float(normal_allocation)

    def to_dict(self):
        return {
            "blacklist": sorted(self.blacklist),
            "seen_count": dict(self.seen_count),
            "halt_count": dict(self.halt_count),
            "halt_value_threshold": self.halt_value_threshold,
            "min_halt_events": self.min_halt_events,
            "min_halt_ratio": self.min_halt_ratio,
            "null_allocation": self.null_allocation,
        }


def reconcile_telemetry(predicted, actual):
    """
    Compare predicted and actual telemetry outcomes and return prediction variance.

    Args:
        predicted: Predicted safe exit/target index.
        actual: Actual observed index from telemetry.

    Returns:
        dict: variance metrics and early-halt signal.
    """
    predicted_exit = float(predicted)
    actual_index = float(actual)
    prediction_variance = predicted_exit - actual_index
    variance_ratio = 0.0 if predicted_exit == 0 else (prediction_variance / predicted_exit)

    return {
        "predicted_exit": predicted_exit,
        "actual_index": actual_index,
        "prediction_variance": prediction_variance,
        "prediction_variance_ratio": variance_ratio,
        "early_halt": actual_index < predicted_exit,
    }


@dataclass
class PID_Controller:
    """PID controller with an auto-calibration loop that prioritizes safety."""

    kp: float = 0.9
    ki: float = 0.12
    kd: float = 0.04
    target_set_point: float = 1.5
    min_target_set_point: float = 0.5
    max_target_set_point: float = 5.0
    integral_limit: float = 200.0
    derivative_gain_step: float = 0.02
    safety_target_step: float = 0.05
    max_kd: float = 2.0
    recovery_threshold_factor: float = 0.75
    recovery_window: int = 3

    integral: float = 0.0
    last_error: float | None = None
    last_output: float = 0.0
    calibration_history: list[dict] = field(default_factory=list)
    post_mortem_history: list[dict] = field(default_factory=list)
    recovery_stance: bool = False
    recovery_thresholds_remaining: int = 0

    def _clamp_target(self, value):
        return max(self.min_target_set_point, min(self.max_target_set_point, float(value)))

    def _clamp_integral(self, value):
        return max(-self.integral_limit, min(self.integral_limit, float(value)))

    def _enter_recovery_stance(self):
        self.recovery_stance = True
        self.recovery_thresholds_remaining = int(self.recovery_window)

    def _clear_recovery_stance(self):
        self.recovery_stance = False
        self.recovery_thresholds_remaining = 0

    def next_sla_threshold(self, sla_threshold):
        """Return the next SLA threshold, applying recovery stance if active."""
        threshold = self._clamp_target(sla_threshold)
        if self.recovery_stance and self.recovery_thresholds_remaining > 0:
            threshold = self._clamp_target(threshold * self.recovery_threshold_factor)
            self.recovery_thresholds_remaining -= 1
            if self.recovery_thresholds_remaining <= 0:
                self._clear_recovery_stance()
        return threshold

    def post_mortem_analysis_loop(self, predicted_exit, actual_index, sla_threshold):
        """
        Compare the prediction to the terminal result and enter recovery stance
        when the actual result underperforms the prediction.

        When recovery is activated, the next three SLA thresholds are reduced by
        25% to protect the stream while stability returns.
        """
        reconciliation = _normalize_reconciliation_result(predicted_exit, actual_index)
        terminal_state = float(actual_index) < float(predicted_exit)

        if terminal_state and reconciliation["prediction_variance"] > 0:
            self._enter_recovery_stance()

        recovery_schedule = []
        if self.recovery_stance:
            remaining = int(self.recovery_thresholds_remaining or self.recovery_window)
            for _ in range(remaining):
                recovery_schedule.append(self._clamp_target(float(sla_threshold) * self.recovery_threshold_factor))

        record = {
            **reconciliation,
            "terminal_state": terminal_state,
            "recovery_stance": self.recovery_stance,
            "recovery_thresholds_remaining": self.recovery_thresholds_remaining,
            "recovery_schedule": recovery_schedule,
            "sla_threshold": self._clamp_target(sla_threshold),
        }

        self.post_mortem_history.append(record)
        if len(self.post_mortem_history) > 200:
            self.post_mortem_history.pop(0)

        return record

    def compute(self, actual_index, dt=1.0):
        """Run one PID step and return the recommended next target/output."""
        measurement = float(actual_index)
        step = max(float(dt), 1e-6)
        error = self.target_set_point - measurement

        self.integral = self._clamp_integral(self.integral + (error * step))
        derivative = 0.0 if self.last_error is None else ((error - self.last_error) / step)

        output = (
            (self.kp * error)
            + (self.ki * self.integral)
            + (self.kd * derivative)
        )

        self.last_error = error
        self.last_output = output

        return {
            "error": error,
            "integral": self.integral,
            "derivative": derivative,
            "output": output,
            "target_set_point": self.target_set_point,
            "recommended_next_target": self._clamp_target(self.target_set_point + output),
        }

    def auto_calibration_loop(self, predicted_exit, actual_index):
        """
        Adapt controller gains/target using observed prediction variance.

        Safety rule:
        - If actual_index < predicted_exit, treat as early system halt.
        - Increase D-term and reduce target_set_point to bias toward safer operation.
        """
        reconciliation = reconcile_telemetry(predicted_exit, actual_index)
        variance = max(0.0, reconciliation["prediction_variance"])
        variance_ratio = max(0.0, reconciliation["prediction_variance_ratio"])
        post_mortem = self.post_mortem_analysis_loop(predicted_exit, actual_index, self.target_set_point)

        if reconciliation["early_halt"]:
            kd_boost = self.derivative_gain_step * max(1.0, variance_ratio)
            self.kd = min(self.max_kd, self.kd + kd_boost)

            target_reduction = self.safety_target_step * max(1.0, variance)
            self.target_set_point = self._clamp_target(self.target_set_point - target_reduction)

            action = "safety_hardened"
        else:
            action = "stable_no_change"

        if post_mortem["recovery_stance"] and post_mortem["recovery_schedule"]:
            self.target_set_point = self.next_sla_threshold(self.target_set_point)

        calibration = {
            **reconciliation,
            "updated_kd": self.kd,
            "updated_target_set_point": self.target_set_point,
            "action": action,
            "post_mortem": post_mortem,
        }

        self.calibration_history.append(calibration)
        if len(self.calibration_history) > 200:
            self.calibration_history.pop(0)

        return calibration
