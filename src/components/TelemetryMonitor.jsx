import { useEffect, useState } from "react";

const API_URL = "http://127.0.0.1:5000/get_stats";

function TelemetryMonitor() {
  const [status, setStatus] = useState("UNKNOWN");
  const [recommendedIntensity, setRecommendedIntensity] = useState("0");
  const [lastUpdated, setLastUpdated] = useState("--");

  useEffect(() => {
    let mounted = true;

    const poll = async () => {
      try {
        const response = await fetch(API_URL, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        if (!mounted) return;

        const systemStatus = String(data.system_status ?? data.decision ?? "UNKNOWN");
        const intensity = String(data.recommended_intensity ?? data.next_stake ?? "0");

        setStatus(systemStatus);
        setRecommendedIntensity(intensity);
        setLastUpdated(new Date().toLocaleTimeString([], { hour12: false }));
      } catch {
        if (!mounted) return;
        setStatus("OFFLINE");
        setLastUpdated(new Date().toLocaleTimeString([], { hour12: false }));
      }
    };

    poll();
    const timer = window.setInterval(poll, 500);

    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  const visualState =
    status === "RECOVERY_MODE" ? "recovery" : status === "NOMINAL" ? "nominal" : "neutral";

  return (
    <section className={`telemetry-monitor ${visualState}`}>
      <div className="telemetry-header">
        <h3>Telemetry Monitor</h3>
        <span className="telemetry-status">{status}</span>
      </div>

      <div className="telemetry-intensity-wrap">
        <span className="telemetry-label">Recommended Intensity</span>
        <strong className="telemetry-intensity">{recommendedIntensity}</strong>
      </div>

      <div className="telemetry-meta">Updated: {lastUpdated}</div>
    </section>
  );
}

export default TelemetryMonitor;