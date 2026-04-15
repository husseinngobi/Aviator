import React, { useEffect, useRef, useState } from "react";
import { useMockStream } from "../hooks/useMockStream";
import { formatNumber } from "../utils/formatNumber";
import Panel from "../components/Panel";
import StatCard from "../components/StatCard";
import EventFeed from "../components/EventFeed";
import TelemetryMonitor from "../components/TelemetryMonitor";
import TelemetryHistory from "../components/TelemetryHistory";
import audioAlertService from "../services/AudioAlertService";

function DashboardPage() {
  const [telemetryAlert, setTelemetryAlert] = useState(null);
  const [stressPulse, setStressPulse] = useState(false);
  const [shutdownImminent, setShutdownImminent] = useState(false);
  const previousStressScoreRef = useRef(null);

  const {
    connection,
    metrics,
    events,
    reference,
    history,
    isPaused,
    lastSyncedAt,
    refreshNow,
    togglePause,
    clearFeed
  } = useMockStream();

  useEffect(() => {
    const onTelemetryAlert = (eventName) => (e) => {
      const detail = e.detail || {};
      setTelemetryAlert({
        label: eventName,
        throughput: detail.throughput_index,
        signature: detail.packet_signature,
        time: new Date().toLocaleTimeString([], { hour12: false })
      });
    };

    const slaListener = onTelemetryAlert("SLAThresholdReached");
    const signatureListener = onTelemetryAlert("PacketSignatureAlert");

    window.addEventListener("SLAThresholdReached", slaListener);
    window.addEventListener("PacketSignatureAlert", signatureListener);

    return () => {
      window.removeEventListener("SLAThresholdReached", slaListener);
      window.removeEventListener("PacketSignatureAlert", signatureListener);
    };
  }, []);

  useEffect(() => {
    const onJitterAnomaly = () => {
      audioAlertService.playJitterWarningBeep();
    };

    const onSlaBreach = () => {
      audioAlertService.playSlaBreachSolidTone();
    };

    const onPreemptiveShutdown = () => {
      audioAlertService.playSlaBreachSolidTone();
      setShutdownImminent(true);
      window.setTimeout(() => setShutdownImminent(false), 1200);
    };

    window.addEventListener("JITTER_ANOMALY", onJitterAnomaly);
    window.addEventListener("SLAThresholdReached", onSlaBreach);
    window.addEventListener("PREEMPTIVE_SHUTDOWN", onPreemptiveShutdown);

    return () => {
      window.removeEventListener("JITTER_ANOMALY", onJitterAnomaly);
      window.removeEventListener("SLAThresholdReached", onSlaBreach);
      window.removeEventListener("PREEMPTIVE_SHUTDOWN", onPreemptiveShutdown);
      audioAlertService.stopAll();
    };
  }, []);

  useEffect(() => {
    const currentScore = Number(metrics.emaStabilityScore ?? 100);
    const previousScore = previousStressScoreRef.current;
    previousStressScoreRef.current = currentScore;

    if (!Number.isFinite(previousScore)) {
      return;
    }

    const scoreDropped = currentScore < previousScore;
    const hasFirstCrashSignature = String(metrics.packetSignature || "").toUpperCase().includes("FIRST_CRASH");
    const isCritical = scoreDropped && (
      currentScore <= 80 ||
      metrics.packetWeightCompression ||
      metrics.preemptiveShutdown ||
      String(metrics.packetMonitorStatus || "").toUpperCase() === "PREEMPTIVE_SHUTDOWN" ||
      hasFirstCrashSignature
    );

    if (!isCritical) {
      return;
    }

    setStressPulse(true);
    audioAlertService.playCriticalRapidBeep();

    const timer = window.setTimeout(() => {
      setStressPulse(false);
    }, 900);

    return () => window.clearTimeout(timer);
  }, [
    metrics.emaStabilityScore,
    metrics.packetWeightCompression,
    metrics.preemptiveShutdown,
    metrics.packetMonitorStatus,
    metrics.packetSignature
  ]);

  const exportSnapshot = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      connection,
      metrics,
      reference,
      history,
      events
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `aviator-dashboard-snapshot-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const riskIndicator = metrics.uiSyncLocked
    ? "LOCKED"
    : String(metrics.riskLevel || "LOW").toUpperCase();

  const isRecalibrating = String(metrics.calibrationStatus || "").toUpperCase() === "RECALIBRATING...";
  const signalStressScore = Math.max(0, Math.min(100, Number(metrics.emaStabilityScore ?? 100)));
  const signalStressCritical = stressPulse || signalStressScore <= 80 || metrics.preemptiveShutdown;
  const showShutdownWarning = shutdownImminent || metrics.preemptiveShutdown || metrics.packetWeightCompression;
  const latestHistoryEntry = Array.isArray(history) && history.length > 0 ? history[0] : null;

  const signalStabilityIcon =
    riskIndicator === "LOW" ? "✅" : riskIndicator === "MEDIUM" ? "▲" : riskIndicator === "HIGH" ? "⚠️" : "■";

  return (
    <main className="dashboard-shell">
      <header className="hud-header">
        <div className="hud-metric-block">
          <span className="hud-label">CURRENT_SLA_TARGET</span>
          <strong className="hud-value hud-prediction">
            {Number(metrics.slaTarget || 0).toFixed(2)}x
            <span className={`hud-stress-symbol ${String(metrics.stressStatus || "").toUpperCase() === "UNSTABLE" ? "unstable" : "stable"}`}>
              {metrics.stressSymbol || "✅"}
            </span>
          </strong>
          <span className={`calibration-badge ${isRecalibrating ? "recalibrating" : "stable"}`}>
            {isRecalibrating ? "RECALIBRATING..." : "CALIBRATED"}
          </span>
        </div>

        <div className="hud-metric-block">
          <span className="hud-label">SIGNAL_STABILITY_ICON</span>
          <strong className={`hud-value hud-icon ${riskIndicator === "LOW" ? "good" : "bad"}`}>
            {signalStabilityIcon}
          </strong>
          <span className="mini-pill muted">Mode {metrics.systemMode || "NOMINAL"}</span>
        </div>

        <div className={`hud-metric-block signal-stress-gauge ${signalStressCritical ? "critical" : "normal"}`}>
          <span className="hud-label">SIGNAL_STRESS_GAUGE</span>
          <div className="signal-stress-readout">
            <strong className="hud-value hud-gauge-value">{signalStressScore.toFixed(0)}%</strong>
            <span className="mini-pill muted">EMA Stability Score</span>
          </div>
          <div className="signal-stress-track" aria-label="Signal stress gauge">
            <span
              className={`signal-stress-fill ${signalStressCritical ? "critical" : ""}`}
              style={{ width: `${signalStressScore}%` }}
            />
          </div>
        </div>
      </header>

      {showShutdownWarning && (
        <div className="shutdown-imminent-banner">
          SHUTDOWN IMMINENT
          <span>
            {metrics.preemptiveShutdownReason || (String(metrics.packetMonitorStatus || "").toUpperCase() === "PREEMPTIVE_SHUTDOWN"
              ? "Packet weight compression detected"
              : metrics.packetSignature || "First crash signature")}
          </span>
        </div>
      )}

      <section className="content-grid single">
        <Panel title="Telemetry Mirror" subtitle="Last 60 system events, newest first">
          <div className="telemetry-history-header">
            <span className="mini-pill muted">Pinned below HUD</span>
            <span className="mini-pill muted">Visible rows {Math.min(history.length, 60)}</span>
            <span className={`mini-pill ${latestHistoryEntry?.hit_sla_target ? "good" : "bad"}`}>
              {latestHistoryEntry ? latestHistoryEntry.sla_outcome || (latestHistoryEntry.hit_sla_target ? "SLA Met" : "SLA Breach") : "Waiting for history"}
            </span>
          </div>
          <div className="telemetry-history-compact">
            <TelemetryHistory history={history} slaTarget={metrics.slaTarget} />
          </div>
        </Panel>
      </section>

      <section className="content-grid single">
        <div className="status-line hud-status-line">
          <span className={`mini-pill ${connection.online ? "good" : "bad"}`}>
            {connection.online ? "Live" : "Offline"}
          </span>
          <span className={`mini-pill ${metrics.analysisReady ? "good" : "muted"}`}>
            {metrics.analysisReady ? "Analysis ready" : "Collecting samples"}
          </span>
          <span className={`mini-pill ${metrics.uiSyncLocked ? "bad" : "good"}`}>
            {metrics.uiSyncLocked ? `UI Sync Locked (${metrics.uiSyncLockReason || "Alert"})` : "UI Sync Unlocked"}
          </span>
          <span className="mini-pill muted">Last sync {lastSyncedAt}</span>
          <span className="mini-pill muted">History {history.length}</span>
          {telemetryAlert && (
            <span className="mini-pill bad">
              {telemetryAlert.label} {telemetryAlert.signature || telemetryAlert.throughput} at {telemetryAlert.time}
            </span>
          )}
        </div>

        <div className="hero-actions hud-actions">
          <button className="ghost-button" type="button" onClick={refreshNow}>
            Refresh now
          </button>
          <button className="ghost-button" type="button" onClick={togglePause}>
            {isPaused ? "Resume" : "Pause"}
          </button>
          <button className="ghost-button" type="button" onClick={exportSnapshot}>
            Export snapshot
          </button>
          <button className="ghost-button danger" type="button" onClick={clearFeed}>
            Clear feed
          </button>
        </div>
      </section>

      <section className="stats-grid">
        <StatCard label="Messages" value={metrics.messages} helper="Live stream frames" />
        <StatCard label="Errors" value={metrics.errors} helper="Captured failures" />
        <StatCard label="Latency" value={`${metrics.latency} ms`} helper="Rolling average" />
        <StatCard label="Uptime" value={`${metrics.uptime}s`} helper="Session duration" />
        <StatCard label="Balance" value={formatNumber(metrics.balance)} helper="Live session balance" />
        <StatCard label="Profit" value={formatNumber(metrics.profit)} helper="Session profit/loss" />
        <StatCard label="Status" value={metrics.decision} helper="Backend status label" />
        <StatCard label="Streak" value={metrics.streak} helper="Current streak counter" />
        <StatCard label="Analysis" value={metrics.analysisReady ? "Ready" : "Collecting"} helper={`${metrics.samples} samples stored`} />
      </section>

      <section className="content-grid">
        <Panel title="Imported Reference" subtitle="Dataset-driven context for the stream">
          <div className="reference-block">
            <div>
              <span className="ref-label">Mode</span>
              <strong>{reference.mode}</strong>
            </div>
            <div>
              <span className="ref-label">Last Update</span>
              <strong>{reference.updatedAt}</strong>
            </div>
            <div>
              <span className="ref-label">Seed Points</span>
              <strong>{formatNumber(reference.points)}</strong>
            </div>
            <div>
              <span className="ref-label">Recent Points</span>
              <strong>{history.length ? `${history.length} mirrored entries` : "No history yet"}</strong>
            </div>
          </div>
        </Panel>

        <Panel title="Session Feed" subtitle="Recent messages and state changes">
          <EventFeed items={events} />
        </Panel>
      </section>

      <section className="content-grid single">
        <Panel title="Session Reminder" subtitle="Simple recovery and focus prompt">
          <div className="reminder-box">
            <p>
              {metrics.uptime > 300
                ? "You have been viewing the session for a while. Consider taking a short break."
                : "Session is fresh. Stay organized and review the live feed as needed."}
            </p>
            <div className="reminder-meta">
              <span>Uptime: {metrics.uptime}s</span>
              <span>Samples: {metrics.samples}</span>
              <span>Status: {metrics.analysisReady ? "Ready" : "Collecting"}</span>
            </div>
          </div>
        </Panel>
      </section>

      <section className="content-grid single">
        <Panel title="Build Area" subtitle="Add your custom logic here">
          <TelemetryMonitor />
        </Panel>
      </section>
    </main>
  );
}

export default DashboardPage;
