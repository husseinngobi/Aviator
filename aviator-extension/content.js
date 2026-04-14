(() => {
    if (window.__WS_TELEMETRY_BRIDGE_ACTIVE__) return;
    window.__WS_TELEMETRY_BRIDGE_ACTIVE__ = true;

    const SIGNAL_URL = "http://127.0.0.1:5000/signal";

    function injectMonitor() {
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("monitor.js");
        script.onload = () => script.remove();
        (document.head || document.documentElement).appendChild(script);
    }

    async function forwardSignal(payload) {
        try {
            await fetch(SIGNAL_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                keepalive: true
            });
        } catch {
            // silent: backend may be offline temporarily
        }
    }

    window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "ws-telemetry-monitor") return;

        forwardSignal({
            event: data.event || "WS_PACKET",
            throughput_index: data.throughput_index ?? null,
            packet_size: data.packet_size ?? 0,
            packet_signature: data.packet_signature ?? null,
            raw: data.raw ?? null,
            timestamp: data.timestamp || Date.now(),
            socket_url: data.socket_url || null,
            marker: data.marker || null
        });
    });

    injectMonitor();
})();