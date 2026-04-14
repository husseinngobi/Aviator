from collections import Counter, deque
from dataclasses import dataclass, field
from statistics import pvariance


DEFAULT_GENERIC_SIGNATURES = {
    "CORRUPTED_FRAME",
    "DROPPED_PACKET",
    "EMPTY_SIGNATURE",
    "FRAGMENTED_PACKET",
    "REPEATED_HEADER",
}


def evaluate_high_frequency_jitter(time_delta_history, time_delta, deviation_ratio=0.15):
    """
    Evaluate packet timing jitter against a rolling 10-sample baseline.

    A jitter spike is detected when the latest absolute deviation exceeds
    `deviation_ratio` of the rolling average time delta.
    """
    samples = [float(x) for x in list(time_delta_history or []) if x is not None]

    if time_delta is not None:
        try:
            latest = float(time_delta)
            if latest >= 0.0:
                samples.append(latest)
        except (TypeError, ValueError):
            latest = None
    else:
        latest = samples[-1] if samples else None

    samples = samples[-10:]
    if not samples:
        return {
            "average_time_delta": 0.0,
            "latest_time_delta": None,
            "jitter_deviation": 0.0,
            "jitter_exceeded": False,
            "sample_count": 0,
        }

    average = sum(samples) / len(samples)
    latest = samples[-1]
    deviation = abs(latest - average)
    threshold = abs(average) * float(deviation_ratio)
    jitter_exceeded = deviation > threshold if average > 0 else False

    return {
        "average_time_delta": round(average, 6),
        "latest_time_delta": round(latest, 6),
        "jitter_deviation": round(deviation, 6),
        "jitter_exceeded": jitter_exceeded,
        "sample_count": len(samples),
    }


def normalize_signature(signature):
    text = str(signature or "").strip().upper()
    if not text:
        return "UNKNOWN"
    collapsed = "_".join(part for part in text.replace("-", "_").split() if part)
    return collapsed or "UNKNOWN"


def recursive_signature_correction(signature, max_depth=3):
    """Recursively normalize a noisy packet signature into a stable label."""
    value = normalize_signature(signature)
    if max_depth <= 0:
        return value

    cleaned = value.replace("__", "_").strip("_")
    if cleaned == value:
        return cleaned or "UNKNOWN"
    return recursive_signature_correction(cleaned, max_depth=max_depth - 1)


@dataclass
class GenericPacketSignatureMonitor:
    """Tracks packet signatures and flags malformed or stalled streams."""

    variance_floor: float = 0.05
    flatline_window: int = 5
    packet_size_threshold: int = 400
    jitter_deviation_ratio: float = 0.15
    critical_signatures: set[str] = field(default_factory=lambda: set(DEFAULT_GENERIC_SIGNATURES))
    critical_dropout_packet_sizes: set[int] = field(default_factory=set)
    history: deque = field(default_factory=lambda: deque(maxlen=32))
    time_delta_history: deque = field(default_factory=lambda: deque(maxlen=10))
    signature_counts: Counter = field(default_factory=Counter)

    def observe(self, throughput_index, packet_signature=None, packet_size=0, time_delta=None):
        normalized_signature = recursive_signature_correction(packet_signature)
        self.signature_counts[normalized_signature] += 1
        self.history.append(float(throughput_index or 0.0))

        try:
            delta = float(time_delta) if time_delta is not None else None
            if delta is not None and delta >= 0.0:
                self.time_delta_history.append(delta)
        except (TypeError, ValueError):
            delta = None

        jitter = evaluate_high_frequency_jitter(
            self.time_delta_history,
            time_delta=delta,
            deviation_ratio=self.jitter_deviation_ratio,
        )

        samples = list(self.history)[-self.flatline_window :]
        variance_value = float(pvariance(samples)) if len(samples) >= 2 else 0.0
        flatline_detected = len(samples) == self.flatline_window and variance_value < float(self.variance_floor)
        signature_hit = normalized_signature in self.critical_signatures
        oversized_packet = int(packet_size or 0) >= int(self.packet_size_threshold)
        packet_dropout_hit = int(packet_size or 0) in self.critical_dropout_packet_sizes
        jitter_exceeded = bool(jitter["jitter_exceeded"])

        preemptive_shutdown = jitter_exceeded or packet_dropout_hit
        if preemptive_shutdown:
            status = "PREEMPTIVE_SHUTDOWN"
        else:
            stalled = flatline_detected or signature_hit
            status = "SYSTEM_STALLED" if stalled else "SYSTEM_ACTIVE"

        return {
            "normalized_signature": normalized_signature,
            "variance": round(variance_value, 6),
            "sample_count": len(samples),
            "flatline_detected": flatline_detected,
            "signature_hit": signature_hit,
            "oversized_packet": oversized_packet,
            "packet_dropout_hit": packet_dropout_hit,
            "jitter_exceeded": jitter_exceeded,
            "average_time_delta": jitter["average_time_delta"],
            "latest_time_delta": jitter["latest_time_delta"],
            "jitter_deviation": jitter["jitter_deviation"],
            "preemptive_shutdown": preemptive_shutdown,
            "sla_override": preemptive_shutdown,
            "sla_override_threshold": 0.0 if preemptive_shutdown else None,
            "status": status,
            "broadcast": status,
            "correction_level": 1 if signature_hit else 0,
            "signature_count": int(self.signature_counts[normalized_signature]),
        }

    def snapshot(self):
        return {
            "variance_floor": self.variance_floor,
            "flatline_window": self.flatline_window,
            "packet_size_threshold": self.packet_size_threshold,
            "jitter_deviation_ratio": self.jitter_deviation_ratio,
            "critical_signatures": sorted(self.critical_signatures),
            "critical_dropout_packet_sizes": sorted(self.critical_dropout_packet_sizes),
            "signature_counts": dict(self.signature_counts),
        }


def evaluate_integrity(
    throughput_history,
    packet_signature,
    next_allocation,
    variance_floor=0.05,
    critical_signatures=None,
    time_delta_history=None,
    time_delta=None,
    jitter_deviation_ratio=0.15,
    packet_size=0,
    critical_dropout_signatures=None,
):
    """
    Evaluate stream integrity and decide whether to stall allocation.

    Rules:
    - Use variance of last 5 Throughput_Index values.
    - If variance < variance_floor OR packet_signature matches critical pattern,
      force next allocation to 0 and broadcast SYSTEM_STALLED.
    """
    critical_set = set(critical_signatures or DEFAULT_GENERIC_SIGNATURES)
    dropout_set = set(int(x) for x in (critical_dropout_signatures or []))

    samples = []
    for item in list(throughput_history or [])[-5:]:
        if isinstance(item, dict):
            numeric = item.get("sensor_value", item.get("control_output", item.get("throughput_index", 0.0)))
        else:
            numeric = item

        try:
            samples.append(float(numeric))
        except (TypeError, ValueError):
            continue

    if len(samples) < 2:
        variance_value = 0.0
    else:
        variance_value = float(pvariance(samples))

    normalized_signature = recursive_signature_correction(packet_signature)
    signature_hit = normalized_signature in critical_set
    flatline_detected = len(samples) == 5 and variance_value < float(variance_floor)
    jitter = evaluate_high_frequency_jitter(
        time_delta_history or [],
        time_delta=time_delta,
        deviation_ratio=jitter_deviation_ratio,
    )
    packet_dropout_hit = int(packet_size or 0) in dropout_set
    jitter_exceeded = bool(jitter["jitter_exceeded"])

    preemptive_shutdown = jitter_exceeded or packet_dropout_hit
    stalled = flatline_detected or signature_hit

    if preemptive_shutdown:
        status = "PREEMPTIVE_SHUTDOWN"
    else:
        status = "SYSTEM_STALLED" if stalled else "SYSTEM_ACTIVE"

    result = {
        "variance": round(variance_value, 6),
        "sample_count": len(samples),
        "flatline_detected": flatline_detected,
        "signature_hit": signature_hit,
        "normalized_signature": normalized_signature,
        "packet_dropout_hit": packet_dropout_hit,
        "jitter_exceeded": jitter_exceeded,
        "average_time_delta": jitter["average_time_delta"],
        "latest_time_delta": jitter["latest_time_delta"],
        "jitter_deviation": jitter["jitter_deviation"],
        "preemptive_shutdown": preemptive_shutdown,
        "sla_override": preemptive_shutdown,
        "sla_override_threshold": 0.0 if preemptive_shutdown else None,
        "status": status,
        "next_allocation": 0.0 if (stalled or preemptive_shutdown) else float(next_allocation),
        "broadcast": status,
    }

    return result
