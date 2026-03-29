import os
import re
from datetime import datetime
from collections import defaultdict

LOG_FILE = "crash_log.txt"

def analyze_patterns():
    if not os.path.exists(LOG_FILE):
        print("❌ No log file found. Play some rounds first!")
        return

    hourly_stats = defaultdict(lambda: {"total": 0, "high": 0})
    total_crashes = 0
    high_crashes = 0

    print("="*45)
    print("   AVIATOR PATTERN ANALYSIS REPORT")
    print("="*45)

    with open(LOG_FILE, "r") as f:
        for line in f:
            # Extract time and multiplier using Regex
            match = re.search(r'\[.* (\d{2}):\d{2}:\d{2}\] CRASH: (\d+\.\d+)x', line)
            if match:
                hour = match.group(1)
                multiplier = float(match.group(2))
                
                hourly_stats[hour]["total"] += 1
                total_crashes += 1
                
                if multiplier >= 2.0:
                    hourly_stats[hour]["high"] += 1
                    high_crashes += 1

    if total_crashes == 0:
        print("No data to analyze yet.")
        return

    # Print Hourly Breakdown
    print(f"{'Hour (EAT)':<12} | {'Win Rate %':<12} | {'Total Rounds'}")
    print("-" * 45)
    
    for hour in sorted(hourly_stats.keys()):
        stats = hourly_stats[hour]
        win_rate = (stats["high"] / stats["total"]) * 100
        print(f"{hour}:00        | {win_rate:>10.1f}% | {stats['total']}")

    print("-" * 45)
    overall_rate = (high_crashes / total_crashes) * 100
    print(f"OVERALL WIN RATE: {overall_rate:.1f}%")
    
    # Identify Best Hour
    best_hour = max(hourly_stats, key=lambda h: (hourly_stats[h]["high"] / hourly_stats[h]["total"]))
    print(f"🔥 RECOMMENDED SESSION TIME: {best_hour}:00 EAT")
    print("="*45)

if __name__ == "__main__":
    analyze_patterns()