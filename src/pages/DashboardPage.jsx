import React, { useEffect, useState } from "react";
import { useMockStream } from "../hooks/useMockStream";
import { formatNumber } from "../utils/formatNumber";
import Panel from "../components/Panel";
import StatCard from "../components/StatCard";
import EventFeed from "../components/EventFeed";
import TelemetryMonitor from "../components/TelemetryMonitor";

function DashboardPage() {
  const [telemetryAlert, setTelemetryAlert] = useState(null);

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
      console.log(eventName, detail);
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

  return (
    <main className="dashboard-shell">
      <header className="hero-card">
        <div>
          <p className="eyebrow">Real-Time Dashboard</p>
          <h1>Stream Monitor Workspace</h1>
          <p className="subtext">
            Generic architecture for live events, metrics, and imported reference data.
          </p>
          <div className="status-line">
            <span className={`mini-pill ${connection.online ? "good" : "bad"}`}>
              {connection.online ? "Live" : "Offline"}
            </span>
            <span className={`mini-pill ${metrics.analysisReady ? "good" : "muted"}`}>
              {metrics.analysisReady ? "Analysis ready" : "Collecting samples"}
            </span>
            <span className="mini-pill muted">Last sync {lastSyncedAt}</span>
            <span className="mini-pill muted">History {history.length}</span>
            {telemetryAlert && (
              <span className="mini-pill bad">
                {telemetryAlert.label} {telemetryAlert.signature || telemetryAlert.throughput} at {telemetryAlert.time}
              </span>
            )}
          </div>
        </div>
        <div className="hero-actions">
          <div className={`connection-badge ${connection.online ? "online" : "offline"}`}>
            {connection.online ? "Connected" : "Disconnected"}
          </div>
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
      </header>

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
        <Panel title="Telemetry History Mirror" subtitle="Exact backend telemetry_history payload">
          <pre className="history-mirror">{JSON.stringify(history, null, 2)}</pre>
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