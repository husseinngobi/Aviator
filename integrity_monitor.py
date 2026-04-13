from statistics import pvariance


DEFAULT_CRITICAL_SIGNATURES = {
    "CRITICAL_DROPOUT",
    "PKT_512_DROP",
    "TERM_OVERFLOW",
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
    critical_set = set(critical_signatures or DEFAULT_CRITICAL_SIGNATURES)

    samples = list(throughput_history or [])[-5:]
    if len(samples) < 2:
        variance_value = 0.0
    else:
        variance_value = float(pvariance(samples))

    signature_hit = str(packet_signature or "").strip() in critical_set
    flatline_detected = len(samples) == 5 and variance_value < float(variance_floor)
    stalled = flatline_detected or signature_hit

    result = {
        "variance": round(variance_value, 6),
        "sample_count": len(samples),
        "flatline_detected": flatline_detected,
        "signature_hit": signature_hit,
        "status": "SYSTEM_STALLED" if stalled else "SYSTEM_ACTIVE",
        "next_allocation": 0.0 if stalled else float(next_allocation),
        "broadcast": "SYSTEM_STALLED" if stalled else "SYSTEM_ACTIVE",
    }

    return result
