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
  const slaTarget = toFloat(entry?.sla_target, toFloat(fallbackSlaTarget, 1.5));
  const pidVarianceRaw = entry?.pid_variance;
  const pidVariance = Number.isFinite(Number(pidVarianceRaw))
    ? Math.abs(Number(pidVarianceRaw))
    : Math.abs(slaTarget) > 0
      ? Math.abs((slaTarget - sensorValue) / slaTarget)
      : Math.abs(toFloat(entry?.variance, 0));

  const confidenceScore = clamp(Math.round(100 - (pidVariance * 100)), 0, 100);
  const hitSlaTarget = sensorValue >= slaTarget;

  return {
    ...entry,
    key: buildEntryKey(entry),
    sensor_value: sensorValue,
    sla_target: slaTarget,
    pid_variance: Number(pidVariance.toFixed(4)),
    confidence_score: confidenceScore,
    hit_sla_target: hitSlaTarget,
    status_weight: hitSlaTarget ? "green" : "red"
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
  const normalizedHistory = useMemo(
    () => (Array.isArray(history) ? history.map((item) => normalizeEntry(item, slaTarget)) : []),
    [history, slaTarget]
  );

  const [entries, setEntries] = useState(normalizedHistory);

  useEffect(() => {
    setEntries(normalizedHistory);
  }, [normalizedHistory]);

  useEffect(() => {
    const onNewTerminalState = (event) => {
      const detail = event.detail;
      if (!detail || typeof detail !== "object") return;

      const normalized = normalizeEntry(detail, slaTarget);
      setEntries((current) => dedupeByKey([normalized, ...current]));
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
              {entry.hit_sla_target ? "SLA Hit" : "SLA Miss"} | Value {entry.sensor_value.toFixed(3)} | Target {entry.sla_target.toFixed(3)}
            </strong>
            <p>
              Signature {entry.packet_signature || "UNKNOWN"} | PID Variance {entry.pid_variance.toFixed(4)}
            </p>
          </div>
          <div className="telemetry-history-meta">
            <span className={`confidence-badge ${entry.status_weight}`}>
              Confidence {entry.confidence_score}%
            </span>
            <time>{String(entry.timestamp ?? "--")}</time>
          </div>
        </article>
      ))}
    </div>
  );
}

export default TelemetryHistory;
