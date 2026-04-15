import React, { useEffect, useMemo, useState } from "react";

function toFloat(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildEntryKey(entry) {
  return String(entry?.timestamp ?? `${entry?.sensor_value ?? "na"}-${entry?.packet_signature ?? "na"}`);
}

function normalizeEntry(entry, fallbackSlaTarget) {
  const sensorValue = toFloat(entry?.sensor_value, 0);
  const finalThroughputIndex = toFloat(
    entry?.final_throughput_index ?? entry?.control_output ?? entry?.sensor_value,
    sensorValue
  );
  const slaTarget = toFloat(entry?.sla_target, toFloat(fallbackSlaTarget, 1.5));
  const pidVarianceRaw = entry?.pid_variance;
  const pidVariance = Number.isFinite(Number(pidVarianceRaw))
    ? Math.abs(Number(pidVarianceRaw))
    : Math.abs(slaTarget) > 0
      ? Math.abs((slaTarget - finalThroughputIndex) / slaTarget)
      : Math.abs(toFloat(entry?.variance, 0));

  const confidenceScore = clamp(Math.round(100 - (pidVariance * 100)), 0, 100);
  const hitSlaTarget = finalThroughputIndex >= slaTarget;
  const firstCrashTrap = finalThroughputIndex < 1.2;

  return {
    ...entry,
    key: buildEntryKey(entry),
    sensor_value: sensorValue,
    final_throughput_index: finalThroughputIndex,
    sla_target: slaTarget,
    pid_variance: Number(pidVariance.toFixed(4)),
    confidence_score: confidenceScore,
    hit_sla_target: hitSlaTarget,
    first_crash_trap: firstCrashTrap,
    sla_outcome: hitSlaTarget ? "SLA Met" : "SLA Breach",
    status_weight: hitSlaTarget ? "sla-met" : "sla-breach"
  };
}

function dedupeByKey(items) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = item?.key ?? buildEntryKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }

  return output;
}

function TelemetryHistory({ history, slaTarget }) {
  const normalizedHistory = useMemo(() => {
    if (!Array.isArray(history)) return [];

    const mapped = history.map((item, index) => ({
      ...normalizeEntry(item, slaTarget),
      __index: index
    }));

    mapped.sort((a, b) => {
      const aTime = Number(new Date(a.timestamp || 0));
      const bTime = Number(new Date(b.timestamp || 0));

      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return bTime - aTime;
      }

      return a.__index - b.__index;
    });

    return mapped.slice(0, 60).map(({ __index, ...entry }) => entry);
  }, [history, slaTarget]);

  const [entries, setEntries] = useState(normalizedHistory);

  useEffect(() => {
    setEntries(normalizedHistory);
  }, [normalizedHistory]);

  useEffect(() => {
    const onNewTerminalState = (event) => {
      const detail = event.detail;
      if (!detail || typeof detail !== "object") return;

      const normalized = normalizeEntry(detail, slaTarget);
      setEntries((current) => dedupeByKey([normalized, ...current]).slice(0, 60));
    };

    window.addEventListener("NEW_TERMINAL_STATE", onNewTerminalState);
    return () => {
      window.removeEventListener("NEW_TERMINAL_STATE", onNewTerminalState);
    };
  }, [slaTarget]);

  if (!entries.length) {
    return <div className="history-empty">No terminal rounds received yet.</div>;
  }

  return (
    <div className="telemetry-history-list">
      {entries.map((entry) => (
        <article key={entry.key} className={`telemetry-history-row ${entry.status_weight}`}>
          <div className="telemetry-history-main">
            <strong>
              {entry.sla_outcome} | Final_Throughput_Index {entry.final_throughput_index.toFixed(3)} | Target {entry.sla_target.toFixed(3)}
            </strong>
            {entry.first_crash_trap && (
              <p className="trap-detected-label">⚠️ TRAP DETECTED | First-Crash Trap under 1.2x</p>
            )}
            <p>
              Signature {entry.packet_signature || "UNKNOWN"} | PID Variance {entry.pid_variance.toFixed(4)}
            </p>
          </div>
          <div className="telemetry-history-meta">
            <span className={`confidence-badge ${entry.status_weight}`}>
              {entry.sla_outcome}
            </span>
            {entry.first_crash_trap && <span className="confidence-badge trap-badge">⚠️ TRAP DETECTED</span>}
            <time>{String(entry.timestamp ?? "--")}</time>
          </div>
        </article>
      ))}
    </div>
  );
}

export default TelemetryHistory;
