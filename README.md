# High-Frequency Telemetry & Congestion Manager

A real-time monitoring system for WebSocket data streams. The project implements an adaptive recovery algorithm to manage request intensity based on throughput efficiency.

## Key Features

- Layer-4 Interceptor: JavaScript WebSocket sniffer that monitors packet density and identifies terminal-state payloads.
- Congestion Controller: Python PID-style controller that scales request intensity (resource allocation) during recovery cycles.
- SLA Enforcement: Automatically resets to baseline throughput once throughput index clears the `1.5x` efficiency threshold.
- Real-Time Pilot Console: Duolingo-styled UI for monitoring system integrity and network jitter.

## System Architecture Overview

The system runs as a feedback loop with three layers.

### 1. Detection Layer (WebSocket Sniffer)

- Monitors incoming frame byte length.
- Normal Tick: Small payload, high frequency.
- Congestion Event: Large payload (`> 400` bytes), signaling a potential halt state.
- Action: Captures `throughput_index` (latest value) and POSTs it to `/signal`.

### 2. Logic Layer (CongestionManager)

The Python backend applies state logic:

- `NOMINAL_STABILITY`
  - Condition: `throughput_index >= 1.50`
  - Action: `request_intensity = 200` (baseline)

- `RECOVERY_MODE`
  - Condition: `throughput_index < 1.50`
  - Action: `request_intensity = previous_intensity * 2.0` (compensatory scaling)

- `CRITICAL_JITTER`
  - Condition: 3 consecutive `throughput_index` values `< 1.30`
  - Action: `request_intensity = 0` (buffer flush)

### 3. Visual Layer (Dashboard)

The dashboard presents a pilot-style view of network health:

- Next Target: SLA efficiency goal (`1.50x`)
- Suggested Intensity: Calculated resource allocation for next cycle
- Trend Monitor: 10-sample moving average to classify throughput trend

## Suggested Folder Structure

```text
Aviator-Project/
|
|-- core/
|   |-- server.py              # Flask API and telemetry routes
|   |-- congestion_logic.py    # SystemController/CongestionManager class
|   `-- telemetry_state.json   # Persistent state storage
|
|-- bridge/
|   `-- injector.js            # WebSocket sniffer (console-paste utility)
|
|-- ui/
|   |-- dashboard.html         # Pilot console
|   `-- dashboard.css          # Stylized UI
|
`-- congestion-manager.agent.md # Copilot instruction set
```

## Quick Start

1. Create and activate a Python virtual environment.
2. Install backend dependencies:
   - `flask`
   - `flask-cors`
3. Start backend:
   - `python server.py`
4. Start frontend (if using Vite React shell):
   - `npm run dev`
5. Inject the sniffer from `websocket-sniffer.js` (or bridge injector) into the browser DevTools console for telemetry monitoring.

## Implementation Note

Because `congestion-manager.agent.md` is already configured, prompts such as "Update the UI for a Recovery Event" can be handled with the established congestion-control context and controller vocabulary.
