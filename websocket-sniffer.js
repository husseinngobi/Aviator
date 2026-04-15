// ==UserScript==
// @name         Aviator WebSocket Sniffer
// @namespace    aviator.telemetry
// @version      1.0.0
// @description  Captures nested iframe websocket telemetry and relays it to local Flask backend.
// @match        *://*.fortebet.com/*
// @match        *://fortebet.com/*
// @connect      fortebet.com
// @connect      127.0.0.1
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    if (window.__TELEMETRY_MONITOR_ACTIVE__) {
        console.warn("Telemetry monitor is already active.");
        return;
    }

    window.__TELEMETRY_MONITOR_ACTIVE__ = true;

    const THRESHOLD_BYTES = 400;
    const SIGNAL_URL = "http://127.0.0.1:5000/signal";
    let lastFinalizedSignature = null;

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

    function extractFinalizedThroughputIndex(json) {
        if (!json || typeof json !== "object") return null;

        // Common finalization markers used by live stream payloads.
        const isFinalized =
            json.type === "f" ||
            json.status === "crashed" ||
            json.event === "finalized";

        if (!isFinalized) return null;

        const rawValue =
            json.throughput_index ??
            json.multiplier ??
            json.value ??
            json.v;

        const numeric = Number(rawValue);
        if (!Number.isFinite(numeric)) return null;
        return numeric;
    }

    function installWebSocketHook(targetWindow) {
        if (!targetWindow || targetWindow.__TELEMETRY_WS_HOOKED__) return;

        const ActualWS = targetWindow.WebSocket;
        if (typeof ActualWS !== "function") return;

        targetWindow.__TELEMETRY_WS_HOOKED__ = true;

        targetWindow.WebSocket = function (...args) {
            const instance = new ActualWS(...args);

            instance.addEventListener("message", (event) => {
                const payload = event.data;
                const packetSize = getPacketSize(payload);
                const json = tryParseJSON(payload);
                const finalizedThroughputIndex = extractFinalizedThroughputIndex(json);

                // Optional marker support for systems that use a terminal-state packet flag.
                const hasTerminalMarker = Boolean(json && json.type === "f");

                if (finalizedThroughputIndex !== null) {
                    const signature = `${finalizedThroughputIndex}|${instance.url}`;

                    // Idempotency: do not resend duplicate finalized packets.
                    if (signature !== lastFinalizedSignature) {
                        lastFinalizedSignature = signature;

                        const signalPayload = {
                            event: "THROUGHPUT_FINALIZED",
                            raw: finalizedThroughputIndex,
                            throughput_index: finalizedThroughputIndex,
                            packet_size: packetSize,
                            timestamp: Date.now(),
                            source: instance.url
                        };

                        const beaconBody = JSON.stringify(signalPayload);
                        targetWindow.navigator.sendBeacon(
                            SIGNAL_URL,
                            new Blob([beaconBody], { type: "application/json" })
                        );
                    }
                }

                if (packetSize > THRESHOLD_BYTES || hasTerminalMarker) {
                    const detail = {
                        timestamp: targetWindow.performance.now(),
                        weight: packetSize,
                        source: instance.url,
                        marker: hasTerminalMarker ? "type:f" : "size-threshold"
                    };

                    targetWindow.dispatchEvent(new CustomEvent("EmergencyStop", { detail }));

                    const body = JSON.stringify({
                        event: "TERMINAL_STATE",
                        latency: detail.timestamp,
                        packetSize,
                        source: instance.url,
                        marker: detail.marker
                    });

                    targetWindow.navigator.sendBeacon(
                        SIGNAL_URL,
                        new Blob([body], { type: "application/json" })
                    );
                }

                targetWindow.dispatchEvent(
                    new CustomEvent("TelemetryTick", {
                        detail: {
                            timestamp: targetWindow.performance.now(),
                            size: packetSize,
                            source: instance.url
                        }
                    })
                );
            });

            return instance;
        };

        targetWindow.WebSocket.prototype = ActualWS.prototype;
        Object.setPrototypeOf(targetWindow.WebSocket, ActualWS);
    }

    function collectAccessibleWindows(rootWindow, seen = new Set()) {
        if (!rootWindow || seen.has(rootWindow)) return seen;
        seen.add(rootWindow);

        let frameCount = 0;
        try {
            frameCount = rootWindow.frames.length;
        } catch {
            return seen;
        }

        for (let index = 0; index < frameCount; index += 1) {
            try {
                const child = rootWindow.frames[index];
                if (child) {
                    collectAccessibleWindows(child, seen);
                }
            } catch {
                // Cross-origin frame: ignore and continue scanning others.
            }
        }

        return seen;
    }

    function installAcrossFrameTree() {
        const targets = collectAccessibleWindows(window);
        targets.forEach((frameWindow) => installWebSocketHook(frameWindow));
        return targets.size;
    }

    const hookedCount = installAcrossFrameTree();

    // Keep watching because some betting pages inject iframes after initial load.
    setInterval(installAcrossFrameTree, 1500);

    console.log(`Telemetry monitor active: watching WebSocket packets in ${hookedCount} frame context(s).`);
})();