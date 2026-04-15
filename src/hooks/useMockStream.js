import { useEffect, useMemo, useRef, useState } from "react";

const API_URL = "http://127.0.0.1:5000";

function buildTimeLabel(date) {
  return date.toLocaleTimeString([], { hour12: false });
}

function toNumber(value) {
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toFloat(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeHistory(value) {
  return Array.isArray(value) ? [...value] : [];
}

export function useMockStream() {
  const [messages, setMessages] = useState(0);
  const [errors, setErrors] = useState(0);
  const [latency, setLatency] = useState(42);
  const [uptime, setUptime] = useState(0);
  const [balance, setBalance] = useState(0);
  const [profit, setProfit] = useState(0);
  const [decision, setDecision] = useState("SYNCING...");
  const [streak, setStreak] = useState(0);
  const [analysisReady, setAnalysisReady] = useState(false);
  const [samples, setSamples] = useState(0);
  const [slaTarget, setSlaTarget] = useState(1.5);
  const [nextSlaTarget, setNextSlaTarget] = useState(1.5);
  const [riskLevel, setRiskLevel] = useState("LOW");
  const [systemMode, setSystemMode] = useState("NOMINAL");
  const [emaStabilityScore, setEmaStabilityScore] = useState(100);
  const [stressSymbol, setStressSymbol] = useState("✅");
  const [stressStatus, setStressStatus] = useState("STABLE");
  const [calibrationStatus, setCalibrationStatus] = useState("CALIBRATED");
  const [packetMonitorStatus, setPacketMonitorStatus] = useState("SYSTEM_ACTIVE");
  const [packetSignature, setPacketSignature] = useState("UNKNOWN");
  const [packetWeightCompression, setPacketWeightCompression] = useState(false);
  const [preemptiveShutdown, setPreemptiveShutdown] = useState(false);
  const [shutdownReason, setShutdownReason] = useState(null);
  const [uiSyncLocked, setUiSyncLocked] = useState(false);
  const [uiSyncLockReason, setUiSyncLockReason] = useState(null);
  const [isPaused, setIsPaused] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(buildTimeLabel(new Date()));
  const [history, setHistory] = useState([]);
  const [events, setEvents] = useState([
    {
      id: 1,
      kind: "message",
      title: "Dashboard ready",
      detail: "Waiting for live backend data.",
      time: buildTimeLabel(new Date())
    }
  ]);
  const lastTerminalKeyRef = useRef(null);
  const lastLatencyRef = useRef(null);
  const lastPreemptiveShutdownRef = useRef(false);
  const lastPacketWeightRef = useRef(null);

  const emitJitterAnomalyIfNeeded = (latencyMs) => {
    const previous = lastLatencyRef.current;
    lastLatencyRef.current = latencyMs;

    if (previous === null || previous === undefined) return;

    const delta = Math.abs(latencyMs - previous);
    if (delta > 15) {
      window.dispatchEvent(
        new CustomEvent("JITTER_ANOMALY", {
          detail: {
            latency_ms: latencyMs,
            previous_latency_ms: previous,
            jitter_delta_ms: delta,
            timestamp: Date.now()
          }
        })
      );
    }
  };

  const emitServerLatencySpikeIfNeeded = (data) => {
    if (!data || !data.latency_spike) return;

    window.dispatchEvent(
      new CustomEvent("JITTER_ANOMALY", {
        detail: {
          latency_spike: true,
          packet_arrival_delta_ms: Number(data.packet_arrival_delta_ms ?? 0),
          timestamp: Date.now()
        }
      })
    );
  };

  const emitPreemptiveShutdownIfNeeded = (data) => {
    const isPreemptive = Boolean(data && data.preemptive_shutdown);
    if (!isPreemptive) {
      lastPreemptiveShutdownRef.current = false;
      return;
    }

    if (lastPreemptiveShutdownRef.current) return;
    lastPreemptiveShutdownRef.current = true;

    window.dispatchEvent(
      new CustomEvent("PREEMPTIVE_SHUTDOWN", {
        detail: {
          preemptive_shutdown: true,
          reason: String(data.preemptive_shutdown_reason || data.packet_monitor_status || "packet_weight_compression"),
          packet_signature: String(data.packet_signature || "UNKNOWN"),
          packet_arrival_delta_ms: Number(data.packet_arrival_delta_ms ?? 0),
          packet_weight_compression: Boolean(data.packet_weight_compression),
          timestamp: Date.now()
        }
      })
    );
  };

  const emitTerminalStateIfNew = (data, telemetryRows) => {
    if (!Array.isArray(telemetryRows) || telemetryRows.length === 0) return;

    const latest = telemetryRows[0];
    if (!latest || typeof latest !== "object") return;

    const latestKey = String(
      latest.timestamp ?? `${latest.sensor_value ?? "na"}-${latest.packet_signature ?? "na"}`
    );

    if (lastTerminalKeyRef.current === latestKey) return;
    lastTerminalKeyRef.current = latestKey;

    window.dispatchEvent(
      new CustomEvent("NEW_TERMINAL_STATE", {
        detail: {
          ...latest,
          sla_target: toFloat(latest.sla_target ?? data?.sla_threshold ?? 1.5, 1.5)
        }
      })
    );
  };

  const handleIntermediateBurst = (detail) => {
    const burst = detail && typeof detail === "object" ? detail : {};
    const packetWeight = Number(burst.weight ?? burst.packetSize ?? burst.packet_size ?? 0);
    const previousWeight = lastPacketWeightRef.current;
    lastPacketWeightRef.current = packetWeight;

    const weightShift = Boolean(burst.weight_shift) || (
      Number.isFinite(previousWeight) && Number.isFinite(packetWeight) && Math.abs(packetWeight - previousWeight) > 120
    );
    const terminalState = Boolean(burst.terminal_state);

    if (!weightShift || terminalState) {
      return;
    }

    setRiskLevel("ABORT");
    setDecision("ABORT");
    setSystemMode("PROTECTIVE");
    setStressStatus("UNSTABLE");
    setPacketMonitorStatus("INTERMEDIATE_PACKET_BURST");

    window.dispatchEvent(
      new CustomEvent("ABORT_RISK_LEVEL", {
        detail: {
          reason: "Intermediate Packet Bursts",
          packet_weight: packetWeight,
          timestamp: Date.now()
        }
      })
    );
  };

  useEffect(() => {
    const onUiSyncLock = (event) => {
      const detail = event.detail || {};
      setUiSyncLocked(true);
      setUiSyncLockReason(String(detail.reason || "UI_SYNC_LOCK"));
    };

    const onUiSyncUnlock = () => {
      setUiSyncLocked(false);
      setUiSyncLockReason(null);
    };

    window.addEventListener("UI_SYNC_LOCK", onUiSyncLock);
    window.addEventListener("UI_SYNC_UNLOCK", onUiSyncUnlock);

    return () => {
      window.removeEventListener("UI_SYNC_LOCK", onUiSyncLock);
      window.removeEventListener("UI_SYNC_UNLOCK", onUiSyncUnlock);
    };
  }, []);

  useEffect(() => {
    const onIntermediateBurst = (event) => {
      handleIntermediateBurst(event.detail || {});
    };

    window.addEventListener("INTERMEDIATE_PACKET_BURST", onIntermediateBurst);
    window.addEventListener("Intermediate Packet Bursts", onIntermediateBurst);

    return () => {
      window.removeEventListener("INTERMEDIATE_PACKET_BURST", onIntermediateBurst);
      window.removeEventListener("Intermediate Packet Bursts", onIntermediateBurst);
    };
  }, []);

  useEffect(() => {
    const start = Date.now();
    let mounted = true;

    const sync = async () => {
      if (isPaused || uiSyncLocked) return;

      const started = performance.now();

      try {
        const response = await fetch(`${API_URL}/get_stats`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

        if (!mounted) return;

        setMessages((count) => count + 1);
        setErrors(0);
        const nextLatency = Math.max(12, Math.round(performance.now() - started));
        setLatency(nextLatency);
        emitJitterAnomalyIfNeeded(nextLatency);
        setUptime(Math.floor((Date.now() - start) / 1000));
        setBalance(toNumber(data.balance));
        setProfit(toNumber(data.profit));
        setDecision(String(data.decision ?? "SYNCING..."));
        setStreak(Number(data.streak ?? 0));
        setAnalysisReady(Boolean(data.analysis_ready));
        setSamples(Number(data.samples ?? 0));
        setRiskLevel(String(data.risk_level ?? "LOW"));
        setSystemMode(String(data.system_mode ?? "NOMINAL"));
        setEmaStabilityScore(Number(data.ema_stability_score ?? 100));
        setStressSymbol(String(data.stress_symbol ?? "✅"));
        setStressStatus(String(data.stress_status ?? "STABLE"));
        setCalibrationStatus(String(data.calibration_status ?? "CALIBRATED"));
        setPacketMonitorStatus(String(data.packet_monitor_status ?? "SYSTEM_ACTIVE"));
        setPacketSignature(String(data.packet_signature ?? "UNKNOWN"));
        setPacketWeightCompression(Boolean(data.packet_weight_compression));
        setPreemptiveShutdown(Boolean(data.preemptive_shutdown));
        setShutdownReason(data.preemptive_shutdown_reason ?? null);
        const telemetryRows = safeHistory(data.telemetry_history ?? data.history);
        setHistory(telemetryRows);
        const nextTarget = toFloat(data.next_sla_target, toFloat(data.sla_threshold, 1.5));
        setSlaTarget(toFloat(data.sla_threshold, 1.5));
        setNextSlaTarget(nextTarget);
        emitPreemptiveShutdownIfNeeded(data);
        emitServerLatencySpikeIfNeeded(data);
        emitTerminalStateIfNew(data, telemetryRows);
        const updatedAt = data.last_updated ? new Date(data.last_updated) : new Date();
        setLastSyncedAt(buildTimeLabel(updatedAt));

        if (Boolean(data.packet_weight_compression) && !Boolean(data.preemptive_shutdown)) {
          handleIntermediateBurst({
            weight_shift: true,
            terminal_state: false,
            packet_size: Number(data.packet_arrival_delta_ms ?? 0),
          });
        }

        setEvents((current) => [
          {
            id: Date.now(),
            kind: "message",
            title: "Live stats synced",
            detail: `Balance ${data.balance} | Profit ${data.profit} | Streak ${data.streak}`,
            time: buildTimeLabel(new Date())
          },
          ...current
        ].slice(0, 8));
      } catch (error) {
        if (!mounted) return;

        setErrors((count) => count + 1);
        const nextLatency = Math.max(12, Math.round(performance.now() - started));
        setLatency(nextLatency);
        emitJitterAnomalyIfNeeded(nextLatency);
        setUptime(Math.floor((Date.now() - start) / 1000));
        setEvents((current) => [
          {
            id: Date.now(),
            kind: "error",
            title: "Backend offline",
            detail: error.message,
            time: buildTimeLabel(new Date())
          },
          ...current
        ].slice(0, 8));
      }
    };

    sync();
    const timer = window.setInterval(sync, 100);

    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [isPaused, uiSyncLocked]);

  const refreshNow = async () => {
    if (uiSyncLocked) {
      return;
    }

    if (isPaused) {
      setIsPaused(false);
    }

    const started = performance.now();

    try {
      const response = await fetch(`${API_URL}/get_stats`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();

      setMessages((count) => count + 1);
      setErrors(0);
      const nextLatency = Math.max(12, Math.round(performance.now() - started));
      setLatency(nextLatency);
      emitJitterAnomalyIfNeeded(nextLatency);
      setUptime((current) => current + 1);
      setBalance(toNumber(data.balance));
      setProfit(toNumber(data.profit));
      setDecision(String(data.decision ?? "SYNCING..."));
      setStreak(Number(data.streak ?? 0));
      setAnalysisReady(Boolean(data.analysis_ready));
      setSamples(Number(data.samples ?? 0));
      setRiskLevel(String(data.risk_level ?? "LOW"));
      setSystemMode(String(data.system_mode ?? "NOMINAL"));
      setEmaStabilityScore(Number(data.ema_stability_score ?? 100));
      setStressSymbol(String(data.stress_symbol ?? "✅"));
      setStressStatus(String(data.stress_status ?? "STABLE"));
      setCalibrationStatus(String(data.calibration_status ?? "CALIBRATED"));
      setPacketMonitorStatus(String(data.packet_monitor_status ?? "SYSTEM_ACTIVE"));
      setPacketSignature(String(data.packet_signature ?? "UNKNOWN"));
      setPacketWeightCompression(Boolean(data.packet_weight_compression));
      setPreemptiveShutdown(Boolean(data.preemptive_shutdown));
      setShutdownReason(data.preemptive_shutdown_reason ?? null);
      const telemetryRows = safeHistory(data.telemetry_history ?? data.history);
      setHistory(telemetryRows);
      const nextTarget = toFloat(data.next_sla_target, toFloat(data.sla_threshold, 1.5));
      setSlaTarget(toFloat(data.sla_threshold, 1.5));
      setNextSlaTarget(nextTarget);
      emitPreemptiveShutdownIfNeeded(data);
      emitServerLatencySpikeIfNeeded(data);
      emitTerminalStateIfNew(data, telemetryRows);
      const updatedAt = data.last_updated ? new Date(data.last_updated) : new Date();
      setLastSyncedAt(buildTimeLabel(updatedAt));

      if (Boolean(data.packet_weight_compression) && !Boolean(data.preemptive_shutdown)) {
        handleIntermediateBurst({
          weight_shift: true,
          terminal_state: false,
          packet_size: Number(data.packet_arrival_delta_ms ?? 0),
        });
      }

      setEvents((current) => [
        {
          id: Date.now(),
          kind: "message",
          title: "Manual refresh completed",
          detail: `Balance ${data.balance} | Profit ${data.profit} | Streak ${data.streak}`,
          time: buildTimeLabel(new Date())
        },
        ...current
      ].slice(0, 8));
    } catch (error) {
      setErrors((count) => count + 1);
      const nextLatency = Math.max(12, Math.round(performance.now() - started));
      setLatency(nextLatency);
      emitJitterAnomalyIfNeeded(nextLatency);
      setEvents((current) => [
        {
          id: Date.now(),
          kind: "error",
          title: "Manual refresh failed",
          detail: error.message,
          time: buildTimeLabel(new Date())
        },
        ...current
      ].slice(0, 8));
    }
  };

  const togglePause = () => setIsPaused((value) => !value);

  const clearFeed = () => {
    setEvents([
      {
        id: Date.now(),
        kind: "message",
        title: "Feed cleared",
        detail: "Local event history was cleared from the view.",
        time: buildTimeLabel(new Date())
      }
    ]);
  };

  const reference = useMemo(() => ({
    mode: "Live telemetry mirror",
    updatedAt: buildTimeLabel(new Date()),
    points: history.length
  }), [history.length]);

  return {
    connection: { online: errors === 0 },
    metrics: {
      messages,
      errors,
      latency,
      uptime,
      balance,
      profit,
      decision,
      streak,
      analysisReady,
      samples,
      slaTarget,
      nextSlaTarget,
      riskLevel,
      systemMode,
      emaStabilityScore,
      stressSymbol,
      stressStatus,
      calibrationStatus,
      packetMonitorStatus,
      packetSignature,
      packetWeightCompression,
      preemptiveShutdown,
      preemptiveShutdownReason: shutdownReason,
      shutdownReason,
      uiSyncLocked,
      uiSyncLockReason
    },
    events,
    reference,
    history,
    isPaused,
    lastSyncedAt,
    refreshNow,
    togglePause,
    clearFeed
  };
}