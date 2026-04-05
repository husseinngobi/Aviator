(function () {
    if (window.__TELEMETRY_MONITOR_ACTIVE__) {
        console.warn("Telemetry monitor is already active.");
        return;
    }

    window.__TELEMETRY_MONITOR_ACTIVE__ = true;

    const ActualWS = window.WebSocket;
    const THRESHOLD_BYTES = 400;
    const SIGNAL_URL = "http://127.0.0.1:5000/signal";

    function getPacketSize(payload) {
        if (typeof payload === "string") {
            return new TextEncoder().encode(payload).length;
        }

        if (payload instanceof Blob) {
            return payload.size;
        }

        if (payload instanceof ArrayBuffer) {
            return payload.byteLength;
        }

        if (ArrayBuffer.isView(payload)) {
            return payload.byteLength;
        }

        return 0;
    }

    function tryParseJSON(payload) {
        if (typeof payload !== "string") return null;
        try {
            return JSON.parse(payload);
        } catch {
            return null;
        }
    }

    window.WebSocket = function (...args) {
        const instance = new ActualWS(...args);

        instance.addEventListener("message", (event) => {
            const payload = event.data;
            const size = getPacketSize(payload);
            const json = tryParseJSON(payload);

            // Optional marker support for systems that use a terminal-state packet flag.
            const hasTerminalMarker = Boolean(json && json.type === "f");

            if (size > THRESHOLD_BYTES || hasTerminalMarker) {
                const detail = {
                    timestamp: performance.now(),
                    weight: size,
                    source: instance.url,
                    marker: hasTerminalMarker ? "type:f" : "size-threshold"
                };

                window.dispatchEvent(new CustomEvent("EmergencyStop", { detail }));

                const body = JSON.stringify({
                    event: "TERMINAL_STATE",
                    latency: detail.timestamp,
                    packetSize: size,
                    source: instance.url,
                    marker: detail.marker
                });

                navigator.sendBeacon(SIGNAL_URL, new Blob([body], { type: "application/json" }));
            }

            window.dispatchEvent(
                new CustomEvent("TelemetryTick", {
                    detail: {
                        timestamp: performance.now(),
                        size,
                        source: instance.url
                    }
                })
            );
        });

        return instance;
    };

    window.WebSocket.prototype = ActualWS.prototype;
    Object.setPrototypeOf(window.WebSocket, ActualWS);

    console.log("Telemetry monitor active: watching WebSocket packets.");
})();