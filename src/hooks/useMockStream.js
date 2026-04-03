import { useEffect, useMemo, useState } from "react";

const API_URL = "http://127.0.0.1:5000";

function buildTimeLabel(date) {
  return date.toLocaleTimeString([], { hour12: false });
}

function toNumber(value) {
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeHistory(value) {
  return Array.isArray(value) ? value.slice(0, 8) : [];
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

  useEffect(() => {
    const start = Date.now();
    let mounted = true;

    const sync = async () => {
      if (isPaused) return;

      const started = performance.now();

      try {
        const response = await fetch(`${API_URL}/get_stats`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

        if (!mounted) return;

        setMessages((count) => count + 1);
        setErrors(0);
        setLatency(Math.max(12, Math.round(performance.now() - started)));
        setUptime(Math.floor((Date.now() - start) / 1000));
        setBalance(toNumber(data.balance));
        setProfit(toNumber(data.profit));
        setDecision(String(data.decision ?? "SYNCING..."));
        setStreak(Number(data.streak ?? 0));
        setAnalysisReady(Boolean(data.analysis_ready));
        setSamples(Number(data.samples ?? 0));
        setHistory(safeHistory(data.history));
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
        setLatency(Math.max(12, Math.round(performance.now() - started)));
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
  }, [isPaused]);

  const refreshNow = async () => {
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
      setLatency(Math.max(12, Math.round(performance.now() - started)));
      setUptime((current) => current + 1);
      setBalance(toNumber(data.balance));
      setProfit(toNumber(data.profit));
      setDecision(String(data.decision ?? "SYNCING..."));
      setStreak(Number(data.streak ?? 0));
      setAnalysisReady(Boolean(data.analysis_ready));
      setSamples(Number(data.samples ?? 0));
      setHistory(safeHistory(data.history));
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
      setLatency(Math.max(12, Math.round(performance.now() - started)));
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
    mode: "Live backend stats",
    updatedAt: buildTimeLabel(new Date()),
    points: history.length
  }), [history.length]);

  return {
    connection: { online: errors === 0 },
    metrics: { messages, errors, latency, uptime, balance, profit, decision, streak, analysisReady, samples },
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