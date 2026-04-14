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
  const [riskLevel, setRiskLevel] = useState("LOW");
  const [systemMode, setSystemMode] = useState("NOMINAL");
  const [stressSymbol, setStressSymbol] = useState("✅");
  const [stressStatus, setStressStatus] = useState("STABLE");
  const [calibrationStatus, setCalibrationStatus] = useState("CALIBRATED");
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
        setStressSymbol(String(data.stress_symbol ?? "✅"));
        setStressStatus(String(data.stress_status ?? "STABLE"));
        setCalibrationStatus(String(data.calibration_status ?? "CALIBRATED"));
        const telemetryRows = safeHistory(data.telemetry_history ?? data.history);
        setHistory(telemetryRows);
        setSlaTarget(toFloat(data.sla_threshold, 1.5));
        emitServerLatencySpikeIfNeeded(data);
        emitTerminalStateIfNew(data, telemetryRows);
        setLastSyncedAt(buildTimeLabel(new Date()));

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
    const timer = window.setInterval(sync, 1000);

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
      setStressSymbol(String(data.stress_symbol ?? "✅"));
      setStressStatus(String(data.stress_status ?? "STABLE"));
      setCalibrationStatus(String(data.calibration_status ?? "CALIBRATED"));
      const telemetryRows = safeHistory(data.telemetry_history ?? data.history);
      setHistory(telemetryRows);
      setSlaTarget(toFloat(data.sla_threshold, 1.5));
      emitServerLatencySpikeIfNeeded(data);
      emitTerminalStateIfNew(data, telemetryRows);
      setLastSyncedAt(buildTimeLabel(new Date()));

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
      riskLevel,
      systemMode,
      stressSymbol,
      stressStatus,
      calibrationStatus,
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