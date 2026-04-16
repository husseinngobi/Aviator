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

  function parseNumeric(value) {
    const num = Number(String(value).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(num) ? num : null;
  }

  function extractThroughputIndex(payload, json) {
    if (json && typeof json === "object") {
      const direct = parseNumeric(
        json.throughput_index ??
        json.multiplier ??
        json.value ??
        json.v ??
        json.m ??
        json.data?.v ??
        json.data?.m ??
        json.data?.multiplier ??
        null
      );

      if (direct !== null) return direct;

      if (json.data && typeof json.data === "object") {
        const nested = parseNumeric(
          json.data.throughput_index ??
          json.data.multiplier ??
          json.data.value ??
          json.data.v ??
          json.data.m ??
          null
        );

        if (nested !== null) return nested;
      }
    }

    if (typeof payload === "string") {
      const inlineMatch = payload.match(/(?:"|')?(?:throughput_index|multiplier|value|v|m)(?:"|')?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (inlineMatch) {
        return parseNumeric(inlineMatch[1]);
      }
    }

    return null;
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
      const throughputIndex = extractThroughputIndex(raw, json);
      const packetSignature = extractPacketSignature(json);
      const isCriticalSignature = CRITICAL_SIGNATURES.has(packetSignature);
      const rawPacketData = typeof raw === "string" ? raw : null;

      if (packetSignature === "CRASH_SIGNAL" || packetSignature === "CRASH" || packetSignature === "TERMINAL_STATE") {
        console.log("[WS TELEMETRY EXT] Crash Signal packet size:", packetSize, "bytes");
        console.log("[WS TELEMETRY EXT] raw event.data preview:", rawPacketData ? rawPacketData.slice(0, 120) : String(raw));
      }

      emitTelemetry({
        event: "WS_PACKET",
        throughput_index: throughputIndex,
        packet_size: packetSize,
        packet_signature: packetSignature,
        raw: rawPacketData,
        raw_packet_data: rawPacketData,
        raw_packet_size: packetSize,
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
            raw: rawPacketData,
            raw_packet_data: rawPacketData,
            raw_packet_size: packetSize,
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
          raw: rawPacketData,
          raw_packet_data: rawPacketData,
          raw_packet_size: packetSize,
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
