(() => {
  if (window.__WS_TELEMETRY_MONITOR_ACTIVE__) return;
  window.__WS_TELEMETRY_MONITOR_ACTIVE__ = true;

  const HEAVY_PACKET_BYTES = 400;
  const CRITICAL_SIGNATURES = new Set([
    "CORRUPTED_FRAME",
    "DROPPED_PACKET",
    "EMPTY_SIGNATURE",
    "FRAGMENTED_PACKET",
    "REPEATED_HEADER"
  ]);
  let lastFinalizedSignature = null;

  function getPacketSize(payload) {
    if (typeof payload === "string") return new TextEncoder().encode(payload).length;
    if (payload instanceof Blob) return payload.size;
    if (payload instanceof ArrayBuffer) return payload.byteLength;
    if (ArrayBuffer.isView(payload)) return payload.byteLength;
    return 0;
  }

  function parseJSON(payload) {
    if (typeof payload !== "string") return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  function extractThroughputIndex(json) {
    if (!json || typeof json !== "object") return null;

    const value =
      json.throughput_index ??
      json.multiplier ??
      json.value ??
      json.v ??
      null;

    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function extractPacketSignature(json) {
    if (!json || typeof json !== "object") return "UNKNOWN";

    const candidate = json.packet_signature ?? json.signature ?? json.event ?? json.type ?? json.marker ?? json.status ?? "UNKNOWN";
    return String(candidate).trim().toUpperCase().replace(/[-\s]+/g, "_") || "UNKNOWN";
  }

  function isFinalizedPacket(json) {
    if (!json || typeof json !== "object") return false;
    return json.type === "f" || json.status === "crashed" || json.event === "finalized";
  }

  function emitTelemetry(payload) {
    window.postMessage(
      {
        source: "ws-telemetry-monitor",
        ...payload
      },
      "*"
    );
  }

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function (...args) {
    const socket = new NativeWebSocket(...args);

    socket.addEventListener("message", (event) => {
      const raw = event.data;
      const packetSize = getPacketSize(raw);
      const json = parseJSON(raw);
      const throughputIndex = extractThroughputIndex(json);
      const packetSignature = extractPacketSignature(json);
      const isCriticalSignature = CRITICAL_SIGNATURES.has(packetSignature);

      emitTelemetry({
        event: "WS_PACKET",
        throughput_index: throughputIndex,
        packet_size: packetSize,
        packet_signature: packetSignature,
        raw: throughputIndex,
        timestamp: Date.now(),
        socket_url: socket.url,
        marker: "tick"
      });

      if (isFinalizedPacket(json)) {
        const signature = `${throughputIndex}|${packetSize}|${socket.url}`;
        if (signature !== lastFinalizedSignature) {
          lastFinalizedSignature = signature;
          emitTelemetry({
            event: "THROUGHPUT_FINALIZED",
            throughput_index: throughputIndex,
            packet_size: packetSize,
            packet_signature: packetSignature,
            raw: throughputIndex,
            timestamp: Date.now(),
            socket_url: socket.url,
            marker: "finalized"
          });
        }
      }

      if (packetSize > HEAVY_PACKET_BYTES) {
        emitTelemetry({
          event: "HEAVY_PACKET",
          throughput_index: throughputIndex,
          packet_size: packetSize,
          packet_signature: packetSignature,
          raw: throughputIndex,
          timestamp: Date.now(),
          socket_url: socket.url,
          marker: "size-threshold"
        });
      }

      if (isCriticalSignature) {
        window.dispatchEvent(
          new CustomEvent("PacketSignatureAlert", {
            detail: {
              packet_signature: packetSignature,
              throughput_index: throughputIndex,
              packet_size: packetSize,
              timestamp: Date.now(),
              socket_url: socket.url
            }
          })
        );
      }
    });

    return socket;
  };

  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(window.WebSocket, NativeWebSocket);

  console.log("[WS TELEMETRY EXT] monitor injected");
})();
