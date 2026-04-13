// ==UserScript==
// @name         Network Telemetry Monitor + Overlay (Safe)
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  WebSocket telemetry monitor with draggable neon overlay badge (no automated UI clicks)
// @match        *://*/games/aviator*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  if (window.__TELEMETRY_TM_ACTIVE__) return;
  window.__TELEMETRY_TM_ACTIVE__ = true;

  const SIGNAL_URL = "http://127.0.0.1:5000/signal";
  const STATS_URL = "http://127.0.0.1:5000/get_stats";
  const HEAVY_PACKET_BYTES = 400;

  const state = {
    slaThreshold: 1.5,
    lastThroughput: null,
    lastPacketSize: 0,
    lastPostedSignature: null,
    statusHit: false,
    badgeReady: false,
    badge: null,
    rowSla: null,
    rowStatus: null,
    rowPkt: null,
    previousHitState: false
  };

  function injectRelayPulseStyles() {
    if (document.getElementById("tm-relay-pulse-style")) return;
    const style = document.createElement("style");
    style.id = "tm-relay-pulse-style";
    style.textContent = `
      @keyframes tmCriticalStrobe {
        0% { background: rgba(255, 0, 0, 0.15); box-shadow: 0 0 6px rgba(255, 0, 0, 0.5); }
        50% { background: rgba(255, 0, 0, 0.95); box-shadow: 0 0 22px rgba(255, 0, 0, 1); }
        100% { background: rgba(255, 0, 0, 0.15); box-shadow: 0 0 6px rgba(255, 0, 0, 0.5); }
      }

      .tm-critical-relay-pulse {
        position: relative !important;
        z-index: 9999 !important;
        animation: tmCriticalStrobe 120ms linear infinite !important;
        outline: 2px solid #ff2b2b !important;
      }
    `;
    document.head.appendChild(style);
  }

  function pulsePrimaryRelaySwitch() {
    const relay = document.getElementById("primary-relay-switch") || document.getElementById("action-trigger");
    if (!relay) return;

    relay.classList.add("tm-critical-relay-pulse");
    relay.style.zIndex = "9999";

    // Keep pulse visible but finite; subsequent critical events will re-apply.
    window.setTimeout(() => {
      relay.classList.remove("tm-critical-relay-pulse");
    }, 2000);
  }

  function setupSlaPulseListener() {
    window.addEventListener("SLAThresholdReached", () => {
      pulsePrimaryRelaySwitch();
    });
  }

  function parseNumeric(value) {
    const n = Number(String(value).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function packetSize(payload) {
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

  function extractThroughput(json) {
    if (!json || typeof json !== "object") return null;
    return parseNumeric(json.throughput_index ?? json.multiplier ?? json.value ?? json.v ?? null);
  }

  async function postSignal(payload) {
    try {
      await fetch(SIGNAL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      });
    } catch {
      // silent
    }
  }

  async function syncSlaThreshold() {
    try {
      const res = await fetch(STATS_URL, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();

      const maybe =
        parseNumeric(data.sla_threshold) ??
        parseNumeric(data.target_set_point) ??
        parseNumeric(data.next_exit);

      if (maybe && maybe > 0) {
        state.slaThreshold = maybe;
      }
      updateOverlay();
    } catch {
      // silent
    }
  }

  function updateOverlay() {
    if (!state.badgeReady) return;

    const throughput = state.lastThroughput;
    const threshold = state.slaThreshold;
    const hit = throughput !== null && throughput >= threshold;
    state.statusHit = hit;

    state.rowSla.textContent = `SLA: ${threshold.toFixed(2)}`;
    state.rowPkt.textContent = `PKT: ${state.lastPacketSize} B`;

    if (hit) {
      state.rowStatus.textContent = "STATUS: HIT";
      state.rowStatus.style.color = "#ff3b3b";
      state.badge.style.boxShadow = "0 0 16px rgba(255,59,59,0.85), inset 0 0 12px rgba(255,59,59,0.35)";
      state.badge.style.borderColor = "#ff3b3b";

      if (!state.previousHitState) {
        window.dispatchEvent(
          new CustomEvent("SLAThresholdReached", {
            detail: {
              throughput_index: throughput,
              sla_threshold: threshold,
              packet_size: state.lastPacketSize,
              timestamp: Date.now()
            }
          })
        );
      }
    } else {
      state.rowStatus.textContent = "STATUS: SAFE";
      state.rowStatus.style.color = "#39ff14";
      state.badge.style.boxShadow = "0 0 16px rgba(57,255,20,0.85), inset 0 0 12px rgba(57,255,20,0.28)";
      state.badge.style.borderColor = "#39ff14";
    }

    state.previousHitState = hit;
  }

  function makeDraggable(el) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onPointerMove = (event) => {
      if (!dragging) return;
      el.style.left = `${event.clientX - offsetX}px`;
      el.style.top = `${event.clientY - offsetY}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    };

    const onPointerUp = () => {
      dragging = false;
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      try {
        localStorage.setItem(
          "telemetryBadgePos",
          JSON.stringify({ left: el.style.left, top: el.style.top })
        );
      } catch {
        // silent
      }
    };

    el.addEventListener("pointerdown", (event) => {
      dragging = true;
      const rect = el.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    });
  }

  function injectOverlay() {
    if (state.badgeReady || !document.body) return;

    const badge = document.createElement("div");
    badge.id = "tm-telemetry-badge";
    badge.style.position = "fixed";
    badge.style.zIndex = "2147483647";
    badge.style.top = "16px";
    badge.style.right = "16px";
    badge.style.minWidth = "180px";
    badge.style.padding = "10px 12px";
    badge.style.border = "2px solid #39ff14";
    badge.style.borderRadius = "12px";
    badge.style.background = "rgba(0, 0, 0, 0.82)";
    badge.style.color = "#eaf6ff";
    badge.style.fontFamily = "Consolas, 'Courier New', monospace";
    badge.style.fontSize = "12px";
    badge.style.lineHeight = "1.45";
    badge.style.cursor = "move";
    badge.style.userSelect = "none";

    const title = document.createElement("div");
    title.textContent = "TELEMETRY";
    title.style.fontWeight = "700";
    title.style.letterSpacing = "0.08em";
    title.style.marginBottom = "6px";
    title.style.color = "#9be8ff";

    const rowSla = document.createElement("div");
    const rowStatus = document.createElement("div");
    const rowPkt = document.createElement("div");

    badge.appendChild(title);
    badge.appendChild(rowSla);
    badge.appendChild(rowStatus);
    badge.appendChild(rowPkt);

    document.body.appendChild(badge);

    try {
      const saved = JSON.parse(localStorage.getItem("telemetryBadgePos") || "null");
      if (saved && saved.left && saved.top) {
        badge.style.left = saved.left;
        badge.style.top = saved.top;
        badge.style.right = "auto";
      }
    } catch {
      // silent
    }

    makeDraggable(badge);

    state.badge = badge;
    state.rowSla = rowSla;
    state.rowStatus = rowStatus;
    state.rowPkt = rowPkt;
    state.badgeReady = true;

    updateOverlay();
  }

  const NativeWS = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new NativeWS(...args);

    ws.addEventListener("message", (event) => {
      const raw = event.data;
      const size = packetSize(raw);
      state.lastPacketSize = size;

      const json = parseJSON(raw);
      const throughput = extractThroughput(json);
      if (throughput !== null) {
        state.lastThroughput = throughput;
      }

      if (size > HEAVY_PACKET_BYTES || (json && json.type === "f")) {
        const sig = `${throughput ?? "na"}|${size}|${ws.url}`;
        if (sig !== state.lastPostedSignature) {
          state.lastPostedSignature = sig;
          postSignal({
            event: "HEAVY_PACKET",
            throughput_index: throughput,
            packet_size: size,
            timestamp: Date.now(),
            source: ws.url
          });
        }
      }

      updateOverlay();
    });

    return ws;
  };

  window.WebSocket.prototype = NativeWS.prototype;
  Object.setPrototypeOf(window.WebSocket, NativeWS);

  const boot = () => {
    injectRelayPulseStyles();
    setupSlaPulseListener();
    injectOverlay();
    syncSlaThreshold();
    setInterval(syncSlaThreshold, 2000);
    requestAnimationFrame(function rafTick() {
      updateOverlay();
      requestAnimationFrame(rafTick);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  console.log("[Telemetry Monitor] active with draggable neon overlay.");
})();
