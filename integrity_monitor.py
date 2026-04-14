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
    critical_signatures: set[str] = field(default_factory=lambda: set(DEFAULT_GENERIC_SIGNATURES))
    history: deque = field(default_factory=lambda: deque(maxlen=32))
    signature_counts: Counter = field(default_factory=Counter)

    def observe(self, throughput_index, packet_signature=None, packet_size=0):
        normalized_signature = recursive_signature_correction(packet_signature)
        self.signature_counts[normalized_signature] += 1
        self.history.append(float(throughput_index or 0.0))

        samples = list(self.history)[-self.flatline_window :]
        variance_value = float(pvariance(samples)) if len(samples) >= 2 else 0.0
        flatline_detected = len(samples) == self.flatline_window and variance_value < float(self.variance_floor)
        signature_hit = normalized_signature in self.critical_signatures
        oversized_packet = int(packet_size or 0) >= int(self.packet_size_threshold)

        stalled = flatline_detected or signature_hit
        status = "SYSTEM_STALLED" if stalled else "SYSTEM_ACTIVE"

        return {
            "normalized_signature": normalized_signature,
            "variance": round(variance_value, 6),
            "sample_count": len(samples),
            "flatline_detected": flatline_detected,
            "signature_hit": signature_hit,
            "oversized_packet": oversized_packet,
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
            "critical_signatures": sorted(self.critical_signatures),
            "signature_counts": dict(self.signature_counts),
        }


def evaluate_integrity(
    throughput_history,
    packet_signature,
    next_allocation,
    variance_floor=0.05,
    critical_signatures=None,
):
    """
    Evaluate stream integrity and decide whether to stall allocation.

    Rules:
    - Use variance of last 5 Throughput_Index values.
    - If variance < variance_floor OR packet_signature matches critical pattern,
      force next allocation to 0 and broadcast SYSTEM_STALLED.
    """
    critical_set = set(critical_signatures or DEFAULT_GENERIC_SIGNATURES)

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
    stalled = flatline_detected or signature_hit

    result = {
        "variance": round(variance_value, 6),
        "sample_count": len(samples),
        "flatline_detected": flatline_detected,
        "signature_hit": signature_hit,
        "normalized_signature": normalized_signature,
        "status": "SYSTEM_STALLED" if stalled else "SYSTEM_ACTIVE",
        "next_allocation": 0.0 if stalled else float(next_allocation),
        "broadcast": "SYSTEM_STALLED" if stalled else "SYSTEM_ACTIVE",
    }

    return result
