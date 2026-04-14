from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import json
import os
import time
from datetime import datetime

from integrity_monitor import GenericPacketSignatureMonitor, evaluate_integrity


class SystemController:
    """PID-based industrial sensor controller with guard rails and warmup handling."""

    def __init__(
        self,
        initial_set_point,
        target_threshold,
        compensatory_factor=1.0,
        warmup_period=5,
        signal_integrity_floor=1.25,
        signal_integrity_cycles=3,
        min_input=0.0,
        max_input=None,
        critical_load_limit=None,
        kp=0.9,
        ki=0.12,
        kd=0.04,
        integral_limit=500.0,
        derivative_smoothing=0.35,
        ema_alpha=0.25,
        low_signal_trigger=2,
        protective_target_factor=0.75,
        min_target_threshold=1.0,
    ):
        if initial_set_point < 0:
            raise ValueError("initial_set_point must be >= 0")
        if compensatory_factor <= 0:
            raise ValueError("compensatory_factor must be > 0")
        if max_input is not None and max_input < min_input:
            raise ValueError("max_input must be >= min_input")
        if critical_load_limit is not None and critical_load_limit < min_input:
            raise ValueError("critical_load_limit must be >= min_input")
        if warmup_period < 0:
            raise ValueError("warmup_period must be >= 0")
        if signal_integrity_cycles < 1:
            raise ValueError("signal_integrity_cycles must be >= 1")

        self.initial_set_point = float(initial_set_point)
        self.target_threshold = float(target_threshold)
        self.compensatory_factor = float(compensatory_factor)
        self.warmup_period = int(warmup_period)
        self.signal_integrity_floor = float(signal_integrity_floor)
        self.signal_integrity_cycles = int(signal_integrity_cycles)
        self.min_input = float(min_input)
        self.max_input = float(max_input) if max_input is not None else None
        self.critical_load_limit = (
            float(critical_load_limit) if critical_load_limit is not None else None
        )

        self.kp = float(kp)
        self.ki = float(ki)
        self.kd = float(kd)
        self.integral_limit = float(integral_limit)
        self.derivative_smoothing = max(0.0, min(1.0, float(derivative_smoothing)))
        self.ema_alpha = max(0.01, min(1.0, float(ema_alpha)))
        self.low_signal_trigger = max(1, int(low_signal_trigger))
        self.protective_target_factor = max(0.1, min(1.0, float(protective_target_factor)))
        self.min_target_threshold = max(0.1, float(min_target_threshold))

        self.current_input = float(initial_set_point)
        self.last_efficiency = None
        self.cycle = 0
        self.system_halt = False
        self.power_saving_mode = False
        self.low_efficiency_streak = 0
        self.integral_term = 0.0
        self.last_error = None
        self.last_derivative = 0.0
        self.last_pid_output = float(initial_set_point)
        self.stability_ema = float(target_threshold)
        self.consecutive_low_signal = 0
        self.system_mode = "NOMINAL"
        self.nominal_target = float(target_threshold)
        self.adaptive_target = float(target_threshold)
        self.risk_level = "LOW"

    def _clamp(self, value):
        value = max(self.min_input, float(value))
        if self.max_input is not None:
            value = min(self.max_input, value)
        return value

    def _limit_integral(self, value):
        return max(-self.integral_limit, min(self.integral_limit, float(value)))

    def _update_stability_ema(self, measurement):
        self.stability_ema = (
            (self.ema_alpha * float(measurement))
            + ((1.0 - self.ema_alpha) * float(self.stability_ema))
        )

    def _update_resilience_mode(self, measurement):
        if float(measurement) < self.signal_integrity_floor:
            self.consecutive_low_signal += 1
        else:
            self.consecutive_low_signal = 0

        if self.consecutive_low_signal >= self.low_signal_trigger:
            self.system_mode = "PROTECTIVE"
            reduced_target = self.nominal_target * self.protective_target_factor
            self.adaptive_target = max(self.min_target_threshold, reduced_target)
        else:
            self.system_mode = "NOMINAL"
            self.adaptive_target = self.nominal_target

    def _derive_risk_level(self):
        if self.system_mode == "PROTECTIVE":
            return "HIGH"

        ratio = (self.stability_ema / self.nominal_target) if self.nominal_target > 0 else 0.0
        if ratio < 0.85:
            return "HIGH"
        if ratio < 1.0:
            return "MEDIUM"
        return "LOW"

    def update(self, efficiency_value, packet_guard=None, dt=1.0, packet_size=None):
        self.cycle += 1
        measurement = float(efficiency_value)
        self.last_efficiency = measurement
        packet_guard = packet_guard or {}

        self._update_stability_ema(measurement)
        self._update_resilience_mode(measurement)
        self.risk_level = self._derive_risk_level()

        if self.system_halt:
            self.current_input = self.min_input
            return {
                "state": "SystemHalt",
                "next_command_input": self.current_input,
                "control_output": self.current_input,
                "reason": "manual_reset_required",
                "risk_level": self.risk_level,
                "system_mode": self.system_mode,
                "adaptive_target": self.adaptive_target,
            }

        if measurement < self.signal_integrity_floor:
            self.low_efficiency_streak += 1
        else:
            self.low_efficiency_streak = 0
            self.power_saving_mode = False

        if self.low_efficiency_streak >= self.signal_integrity_cycles:
            self.power_saving_mode = True

        if packet_guard.get("status") == "SYSTEM_STALLED":
            self.power_saving_mode = True
            self.current_input = self.min_input
            return {
                "state": "PacketSignatureHold",
                "next_command_input": self.current_input,
                "control_output": self.current_input,
                "reason": "packet_signature_stall",
                "packet_signature": packet_guard.get("normalized_signature", "UNKNOWN"),
                "risk_level": self.risk_level,
                "system_mode": self.system_mode,
                "adaptive_target": self.adaptive_target,
            }

        if self.power_saving_mode:
            self.current_input = self.min_input
            return {
                "state": "PowerSavingMode",
                "next_command_input": self.current_input,
                "control_output": self.current_input,
                "reason": "signal_integrity_low",
                "risk_level": self.risk_level,
                "system_mode": self.system_mode,
                "adaptive_target": self.adaptive_target,
            }

        if self.cycle <= self.warmup_period:
            pid_output = self.initial_set_point
            self.integral_term = 0.0
            self.last_error = self.target_threshold - measurement
            self.last_derivative = 0.0
            state = "Warmup"
            reason = "warmup_baseline"
        else:
            error = self.adaptive_target - measurement
            proportional = self.kp * error
            self.integral_term = self._limit_integral(self.integral_term + (error * dt))
            derivative = 0.0 if self.last_error is None else (error - self.last_error) / max(dt, 1e-6)
            smoothed_derivative = (
                (self.derivative_smoothing * derivative)
                + ((1.0 - self.derivative_smoothing) * self.last_derivative)
            )

            pid_output = self.initial_set_point + proportional + (self.ki * self.integral_term) + (self.kd * smoothed_derivative)
            pid_output *= self.compensatory_factor if measurement < self.adaptive_target else 1.0
            self.last_error = error
            self.last_derivative = smoothed_derivative
            state = "PID_Recovery" if measurement < self.adaptive_target else "PID_Tracking"
            reason = "compensating" if measurement < self.adaptive_target else "nominal_reset"

        candidate = self._clamp(pid_output)

        if self.critical_load_limit is not None and candidate > self.critical_load_limit:
            self.system_halt = True
            self.current_input = self.min_input
            return {
                "state": "SystemHalt",
                "next_command_input": self.current_input,
                "control_output": self.current_input,
                "reason": "critical_load_limit_exceeded",
                "risk_level": "HIGH",
                "system_mode": "PROTECTIVE",
                "adaptive_target": self.adaptive_target,
            }

        self.current_input = candidate
        self.last_pid_output = candidate
        return {
            "state": state,
            "next_command_input": self.current_input,
            "control_output": self.current_input,
            "reason": reason,
            "risk_level": self.risk_level,
            "system_mode": self.system_mode,
            "adaptive_target": self.adaptive_target,
        }

    def reset(self):
        self.system_halt = False
        self.power_saving_mode = False
        self.low_efficiency_streak = 0
        self.current_input = self.initial_set_point
        self.last_efficiency = None
        self.cycle = 0
        self.integral_term = 0.0
        self.last_error = None
        self.last_derivative = 0.0
        self.last_pid_output = self.initial_set_point
        self.stability_ema = self.nominal_target
        self.consecutive_low_signal = 0
        self.system_mode = "NOMINAL"
        self.adaptive_target = self.nominal_target
        self.risk_level = "LOW"

    def get_state(self):
        return {
            "current_input": self.current_input,
            "last_efficiency": self.last_efficiency,
            "cycle": self.cycle,
            "warmup_period": self.warmup_period,
            "system_halt": self.system_halt,
            "power_saving_mode": self.power_saving_mode,
            "low_efficiency_streak": self.low_efficiency_streak,
            "signal_integrity_floor": self.signal_integrity_floor,
            "signal_integrity_cycles": self.signal_integrity_cycles,
            "critical_load_limit": self.critical_load_limit,
            "kp": self.kp,
            "ki": self.ki,
            "kd": self.kd,
            "integral_term": self.integral_term,
            "last_error": self.last_error,
            "last_pid_output": self.last_pid_output,
            "stability_ema": self.stability_ema,
            "consecutive_low_signal": self.consecutive_low_signal,
            "system_mode": self.system_mode,
            "risk_level": self.risk_level,
            "nominal_target": self.nominal_target,
            "adaptive_target": self.adaptive_target,
        }

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# --- SYSTEM CONFIGURATION ---
STATE_FILE = "telemetry_state.json"
BASE_ALLOCATION = 200.0  # Initial Resource Units
target_efficiency = 1.50  # Efficiency Set-Point
MIN_SLA_THRESHOLD = 0.10

# Global State Variables
current_integrity = 0.0
session_start_integrity = 0.0
telemetry_history = []
signal_history = telemetry_history
operational_streak = 0
current_allocation = BASE_ALLOCATION
last_ping_ms = 0.0
last_packet_arrival_ms = None
last_inter_packet_delta_ms = 0.0
packet_monitor = GenericPacketSignatureMonitor()
controller = SystemController(
    initial_set_point=BASE_ALLOCATION,
    target_threshold=target_efficiency,
    compensatory_factor=1.15,
    warmup_period=5,
    signal_integrity_floor=1.25,
    signal_integrity_cycles=3,
    min_input=0.0,
    max_input=BASE_ALLOCATION * 4,
    critical_load_limit=BASE_ALLOCATION * 3,
)


def compute_latency_adjusted_threshold(base_threshold, ping_ms):
    """
    Dynamic latency compensator:
    If ping > 50ms, reduce threshold by (ping/1000) * 2.0.
    """
    base = float(base_threshold)
    ping = max(0.0, float(ping_ms or 0.0))

    if ping <= 50.0:
        return round(base, 4)

    reduction = (ping / 1000.0) * 2.0
    adjusted = max(MIN_SLA_THRESHOLD, base - reduction)
    return round(adjusted, 4)

def load_system_state():
    global current_integrity, session_start_integrity, telemetry_history, operational_streak, last_ping_ms, last_inter_packet_delta_ms
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                data = json.load(f)
                current_integrity = data.get("current_integrity", 0.0)
                telemetry_history[:] = data.get("telemetry_history", data.get("history", []))
                operational_streak = data.get("streak", 0)
                last_ping_ms = data.get("ping_ms", 0.0)
                last_inter_packet_delta_ms = float(data.get("last_inter_packet_delta_ms", 0.0) or 0.0)
                controller_state = data.get("controller_state", {})
                controller.current_input = float(controller_state.get("current_input", controller.current_input))
                controller.last_efficiency = controller_state.get("last_efficiency", controller.last_efficiency)
                controller.cycle = int(controller_state.get("cycle", controller.cycle))
                controller.system_halt = bool(controller_state.get("system_halt", controller.system_halt))
                controller.power_saving_mode = bool(controller_state.get("power_saving_mode", controller.power_saving_mode))
                controller.low_efficiency_streak = int(controller_state.get("low_efficiency_streak", controller.low_efficiency_streak))
                controller.integral_term = float(controller_state.get("integral_term", controller.integral_term))
                controller.last_error = controller_state.get("last_error", controller.last_error)
                controller.last_pid_output = float(controller_state.get("last_pid_output", controller.last_pid_output))
                controller.stability_ema = float(controller_state.get("stability_ema", controller.stability_ema))
                controller.consecutive_low_signal = int(controller_state.get("consecutive_low_signal", controller.consecutive_low_signal))
                controller.system_mode = str(controller_state.get("system_mode", controller.system_mode))
                controller.risk_level = str(controller_state.get("risk_level", controller.risk_level))
                controller.nominal_target = float(controller_state.get("nominal_target", controller.nominal_target))
                controller.adaptive_target = float(controller_state.get("adaptive_target", controller.adaptive_target))
        except Exception as e: print(f"Init Error: {e}")

def save_system_state():
    with open(STATE_FILE, "w") as f:
        json.dump({
            "current_integrity": current_integrity,
            "telemetry_history": telemetry_history,
            "history": telemetry_history,
            "streak": operational_streak,
            "ping_ms": last_ping_ms,
            "last_inter_packet_delta_ms": last_inter_packet_delta_ms,
            "controller_state": controller.get_state(),
        }, f)


def _is_latency_spike(delta_ms):
    try:
        return float(delta_ms) > 15.0
    except (TypeError, ValueError):
        return False


def derive_calibration_status(sensor_value, sla_threshold, controller_result):
    """Return calibration status label for HUD display."""
    try:
        measured = float(sensor_value)
        target = float(sla_threshold)
    except (TypeError, ValueError):
        measured = 0.0
        target = 0.0

    state = str((controller_result or {}).get("state", ""))
    reason = str((controller_result or {}).get("reason", ""))
    missed_round = measured < target if target > 0 else False
    recalibrating = missed_round and (state == "PID_Recovery" or reason == "compensating")

    return "RECALIBRATING..." if recalibrating else "CALIBRATED"


def recursive_numeric_correction(payload, candidate_keys=("sensor_value", "throughput_index", "value", "raw", "reading"), depth=0, max_depth=4):
    """Recursively extract a numeric telemetry value from nested payloads."""
    if depth > max_depth:
        return None

    if isinstance(payload, (int, float)):
        return float(payload)

    if isinstance(payload, list):
        for item in payload:
            value = recursive_numeric_correction(item, candidate_keys, depth + 1, max_depth)
            if value is not None:
                return value
        return None

    if isinstance(payload, dict):
        for key in candidate_keys:
            if key in payload:
                value = recursive_numeric_correction(payload.get(key), candidate_keys, depth + 1, max_depth)
                if value is not None:
                    return value

        for value in payload.values():
            extracted = recursive_numeric_correction(value, candidate_keys, depth + 1, max_depth)
            if extracted is not None:
                return extracted

    try:
        return float(payload)
    except (TypeError, ValueError):
        return None


def coerce_packet_size(payload):
    value = recursive_numeric_correction(payload, candidate_keys=("packet_size", "bytes", "size", "length"))
    return int(value) if value is not None else 0


def coerce_packet_signature(payload):
    if isinstance(payload, dict):
        for key in ("packet_signature", "signature", "event", "type", "marker", "status"):
            if key in payload and payload.get(key) is not None:
                return str(payload.get(key)).strip()
    return str(payload or "UNKNOWN").strip()

# --- DYNAMIC RISK & ALLOCATION ENGINE ---
def calculate_resource_scaling(history, integrity, efficiency_target):
    """
    Legacy wrapper that now exposes the latest PID-controlled command output.
    """
    global current_allocation
    
    if len(history) < 3:
        return "INITIALIZING...", BASE_ALLOCATION, 0.0

    latest = history[0]
    if isinstance(latest, dict):
        status = str(latest.get("controller_state", latest.get("state", "PID_TRACKING")))
        allocation = float(latest.get("control_output", latest.get("next_command_input", BASE_ALLOCATION)))
        target = float(latest.get("sensor_value", latest.get("throughput_index", efficiency_target)))
        current_allocation = allocation
        return status, allocation, target

    if history[0] < efficiency_target:
        current_allocation *= 1.0 + max(0.0, controller.compensatory_factor - 1.0)
        status = "PID_RECOVERY"
    else:
        current_allocation = BASE_ALLOCATION
        status = "PID_TRACKING"

    return status, current_allocation, efficiency_target


@app.route('/ping', methods=['POST'])
def update_ping():
    """
    Receive browser-measured ping in milliseconds.
    Expected payload: { "ping_ms": <number> }
    """
    global last_ping_ms

    data = request.get_json(force=True, silent=True) or {}
    ping_ms = data.get("ping_ms")

    try:
        last_ping_ms = max(0.0, float(ping_ms))
    except (TypeError, ValueError):
        return jsonify({"status": "invalid_ping"}), 400

    adjusted = compute_latency_adjusted_threshold(target_efficiency, last_ping_ms)
    return jsonify({
        "status": "ok",
        "ping_ms": last_ping_ms,
        "sla_threshold": adjusted,
    })


def _build_history_record(data, sensor_value, packet_signature, packet_size, packet_guard, controller_result):
    timestamp = data.get("timestamp")
    if timestamp is None:
        timestamp = datetime.utcnow().isoformat(timespec="milliseconds") + "Z"

    return {
        "timestamp": timestamp,
        "sensor_value": round(sensor_value, 6),
        "packet_signature": packet_signature,
        "packet_size": int(packet_size),
        "normalized_signature": packet_guard.get("normalized_signature", "UNKNOWN"),
        "monitor_status": packet_guard.get("status", "SYSTEM_ACTIVE"),
        "signature_hit": bool(packet_guard.get("signature_hit", False)),
        "flatline_detected": bool(packet_guard.get("flatline_detected", False)),
        "variance": packet_guard.get("variance", 0.0),
        "control_output": round(float(controller_result.get("control_output", controller_result.get("next_command_input", 0.0))), 6),
        "controller_state": controller_result.get("state", "PID_TRACKING"),
        "controller_reason": controller_result.get("reason", "unknown"),
        "risk_level": controller_result.get("risk_level", controller.risk_level),
        "system_mode": controller_result.get("system_mode", controller.system_mode),
        "adaptive_target": round(float(controller_result.get("adaptive_target", controller.adaptive_target)), 6),
        "packet_signature_count": packet_guard.get("signature_count", 0),
        "packet_arrival_delta_ms": round(float(last_inter_packet_delta_ms), 3),
        "latency_spike": _is_latency_spike(last_inter_packet_delta_ms),
        "stress_symbol": packet_guard.get("stress_symbol", "✅"),
        "stress_status": packet_guard.get("stress_status", "STABLE"),
        "calibration_status": derive_calibration_status(
            sensor_value,
            data.get("sla_threshold", target_efficiency),
            controller_result,
        ),
    }

# --- TELEMETRY ROUTES ---

@app.route('/signal', methods=['POST'])
def process_telemetry():
    """
    High-speed endpoint for telemetry interception.
    """
    global telemetry_history, operational_streak, current_integrity, current_allocation
    global last_packet_arrival_ms, last_inter_packet_delta_ms
    
    data = request.get_json(force=True, silent=True) or {}
    if not data: return jsonify({"status": "no_data"}), 400

    now_ms = time.perf_counter() * 1000.0
    if last_packet_arrival_ms is None:
        last_inter_packet_delta_ms = 0.0
    else:
        last_inter_packet_delta_ms = max(0.0, now_ms - float(last_packet_arrival_ms))
    last_packet_arrival_ms = now_ms

    sensor_value = recursive_numeric_correction(data)
    if sensor_value is None:
        sensor_value = float(data.get("throughput_index", data.get("raw", 0.0)) or 0.0)

    packet_signature = coerce_packet_signature(data)
    packet_size = coerce_packet_size(data)
    current_integrity = float(sensor_value)

    if "ping_ms" in data:
        try:
            globals()["last_ping_ms"] = max(0.0, float(data.get("ping_ms")))
        except (TypeError, ValueError):
            pass

    packet_guard = packet_monitor.observe(
        throughput_index=sensor_value,
        packet_signature=packet_signature,
        packet_size=packet_size,
        time_delta=last_inter_packet_delta_ms,
    )

    controller_result = controller.update(
        sensor_value,
        packet_guard=packet_guard,
        dt=float(data.get("dt", 1.0) or 1.0),
        packet_size=packet_size,
    )

    effective_threshold = compute_latency_adjusted_threshold(target_efficiency, last_ping_ms)
    integrity_result = evaluate_integrity(
        [item.get("sensor_value", 0.0) if isinstance(item, dict) else item for item in telemetry_history],
        packet_guard.get("normalized_signature", packet_signature),
        controller_result.get("next_command_input", BASE_ALLOCATION),
        variance_floor=0.05,
    )

    if integrity_result.get("status") == "SYSTEM_STALLED":
        controller_result = {
            **controller_result,
            "state": "PacketSignatureHold",
            "next_command_input": 0.0,
            "control_output": 0.0,
            "reason": "integrity_monitor_hold",
        }

    telemetry_record = _build_history_record(
        data,
        sensor_value,
        packet_signature,
        packet_size,
        packet_guard,
        controller_result,
    )

    telemetry_record["calibration_status"] = derive_calibration_status(
        sensor_value,
        effective_threshold,
        controller_result,
    )

    telemetry_history.insert(0, telemetry_record)
    if len(telemetry_history) > 500:
        telemetry_history.pop()

    if sensor_value >= target_efficiency:
        operational_streak += 1
    else:
        operational_streak = 0

    current_allocation = float(controller_result.get("control_output", controller.current_input))
    save_system_state()

    return jsonify({
        "status": controller_result.get("state", "PID_TRACKING"),
        "allocation_units": f"{current_allocation:,.0f} UGX",
        "target_set_point": f"{effective_threshold}x",
        "sla_threshold": effective_threshold,
        "ping_ms": round(last_ping_ms, 2),
        "streak": operational_streak,
        "packet_signature": packet_guard.get("normalized_signature", packet_signature),
        "packet_monitor_status": packet_guard.get("status", "SYSTEM_ACTIVE"),
        "risk_level": controller_result.get("risk_level", controller.risk_level),
        "system_mode": controller_result.get("system_mode", controller.system_mode),
        "adaptive_target": round(float(controller_result.get("adaptive_target", controller.adaptive_target)), 6),
        "packet_arrival_delta_ms": round(float(last_inter_packet_delta_ms), 3),
        "latency_spike": _is_latency_spike(last_inter_packet_delta_ms),
        "stress_symbol": packet_guard.get("stress_symbol", "✅"),
        "stress_status": packet_guard.get("stress_status", "STABLE"),
        "calibration_status": telemetry_record.get("calibration_status", "CALIBRATED"),
        "control_output": round(current_allocation, 6),
        "telemetry_history": telemetry_history,
        "history": telemetry_history,
        "controller_state": controller.get_state(),
        "packet_monitor": packet_monitor.snapshot(),
    })

@app.route('/get_stats', methods=['GET'])
def get_stats():
    effective_threshold = compute_latency_adjusted_threshold(target_efficiency, last_ping_ms)
    latest_record = telemetry_history[0] if telemetry_history else {}
    if isinstance(latest_record, dict):
        status = str(latest_record.get("controller_state", "PID_TRACKING"))
        allocation = float(latest_record.get("control_output", controller.current_input))
        target = float(effective_threshold)
        packet_status = latest_record.get("monitor_status", "SYSTEM_ACTIVE")
        packet_signature = latest_record.get("normalized_signature", "UNKNOWN")
        packet_arrival_delta_ms = float(latest_record.get("packet_arrival_delta_ms", last_inter_packet_delta_ms) or 0.0)
        latency_spike = bool(latest_record.get("latency_spike", _is_latency_spike(packet_arrival_delta_ms)))
        risk_level = str(latest_record.get("risk_level", controller.risk_level))
        system_mode = str(latest_record.get("system_mode", controller.system_mode))
        adaptive_target = float(latest_record.get("adaptive_target", controller.adaptive_target) or controller.adaptive_target)
        stress_symbol = str(latest_record.get("stress_symbol", "✅"))
        stress_status = str(latest_record.get("stress_status", "UNSTABLE" if latency_spike else "STABLE"))
        calibration_status = str(
            latest_record.get(
                "calibration_status",
                derive_calibration_status(
                    latest_record.get("sensor_value", current_integrity),
                    effective_threshold,
                    {"state": status, "reason": latest_record.get("controller_reason", "")},
                ),
            )
        )
    else:
        status, allocation, target = calculate_resource_scaling(
            telemetry_history,
            current_integrity,
            effective_threshold,
        )
        packet_status = "SYSTEM_ACTIVE"
        packet_signature = "UNKNOWN"
        packet_arrival_delta_ms = float(last_inter_packet_delta_ms or 0.0)
        latency_spike = _is_latency_spike(packet_arrival_delta_ms)
        risk_level = str(controller.risk_level)
        system_mode = str(controller.system_mode)
        adaptive_target = float(controller.adaptive_target)
        stress_symbol = "⚠️" if latency_spike else "✅"
        stress_status = "UNSTABLE" if latency_spike else "STABLE"
        calibration_status = derive_calibration_status(current_integrity, effective_threshold, {"state": status, "reason": ""})

    return jsonify({
        "balance": f"{current_integrity:,.2f} UGX",
        "telemetry_history": telemetry_history,
        "history": telemetry_history,
        "decision": status,
        "system_status": status,
        "next_stake": f"{allocation:,.0f} UGX",
        "recommended_intensity": f"{allocation:,.0f} UGX",
        "next_exit": f"{target}x",
        "sla_threshold": target,
        "ping_ms": round(last_ping_ms, 2),
        "streak": operational_streak,
        "packet_monitor_status": packet_status,
        "packet_signature": packet_signature,
        "risk_level": risk_level,
        "system_mode": system_mode,
        "adaptive_target": round(adaptive_target, 6),
        "packet_arrival_delta_ms": round(packet_arrival_delta_ms, 3),
        "latency_spike": latency_spike,
        "stress_symbol": stress_symbol,
        "stress_status": stress_status,
        "calibration_status": calibration_status,
        "control_output": round(allocation, 6),
        "controller_state": controller.get_state(),
        "packet_monitor": packet_monitor.snapshot(),
        "analysis_ready": bool(telemetry_history),
        "samples": len(telemetry_history),
    })

if __name__ == '__main__':
    load_system_state()
    app.run(host='127.0.0.1', port=5000, threaded=True)