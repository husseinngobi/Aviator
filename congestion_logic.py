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
