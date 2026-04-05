from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import json
import os
from datetime import datetime


class SystemController:
    """
    Stateful controller with compensatory scaling and a thermal safety latch.

    Rules:
    - If efficiency drops below threshold: scale command by compensatory factor.
    - If efficiency is nominal: reset command to initial set point.
    - If command exceeds critical_load_limit: enter SystemHalt and force min_input.
    - While halted: always return min_input until reset() is called.
    """

    def __init__(
        self,
        initial_set_point,
        target_threshold,
        compensatory_factor=2.0,
        warmup_period=5,
        signal_integrity_floor=1.25,
        signal_integrity_cycles=3,
        min_input=0.0,
        max_input=None,
        critical_load_limit=None,
    ):
        if initial_set_point < 0:
            raise ValueError("initial_set_point must be >= 0")
        if compensatory_factor <= 0:
            raise ValueError("compensatory_factor must be > 0")
        if max_input is not None and max_input < min_input:
            raise ValueError("max_input must be >= min_input")
        if critical_load_limit is not None and critical_load_limit < min_input:
            raise ValueError("critical_load_limit must be >= min_input")
        if warmup_period < 0:
            raise ValueError("warmup_period must be >= 0")
        if signal_integrity_cycles < 1:
            raise ValueError("signal_integrity_cycles must be >= 1")

        self.initial_set_point = float(initial_set_point)
        self.target_threshold = float(target_threshold)
        self.compensatory_factor = float(compensatory_factor)
        self.warmup_period = int(warmup_period)
        self.signal_integrity_floor = float(signal_integrity_floor)
        self.signal_integrity_cycles = int(signal_integrity_cycles)
        self.min_input = float(min_input)
        self.max_input = float(max_input) if max_input is not None else None
        self.critical_load_limit = (
            float(critical_load_limit) if critical_load_limit is not None else None
        )

        self.current_input = float(initial_set_point)
        self.last_efficiency = None
        self.cycle = 0
        self.system_halt = False
        self.power_saving_mode = False
        self.low_efficiency_streak = 0

    def _clamp(self, value):
        value = max(self.min_input, float(value))
        if self.max_input is not None:
            value = min(self.max_input, value)
        return value

    def update(self, efficiency_value):
        self.cycle += 1
        self.last_efficiency = float(efficiency_value)

        # Thermal safety latch: once halted, keep minimum command until manual reset.
        if self.system_halt:
            self.current_input = self.min_input
            return {
                "state": "SystemHalt",
                "next_command_input": self.current_input,
                "reason": "manual_reset_required",
            }

        if self.last_efficiency < self.signal_integrity_floor:
            self.low_efficiency_streak += 1
        else:
            self.low_efficiency_streak = 0
            self.power_saving_mode = False

        if self.low_efficiency_streak >= self.signal_integrity_cycles:
            self.power_saving_mode = True

        if self.power_saving_mode:
            self.current_input = 0.0
            return {
                "state": "PowerSavingMode",
                "next_command_input": self.current_input,
                "reason": "signal_integrity_low",
            }

        if self.cycle <= self.warmup_period:
            candidate = self.initial_set_point
            reason = "warmup_baseline"
        elif self.last_efficiency < self.target_threshold:
            candidate = self.current_input * self.compensatory_factor
            reason = "compensating"
        else:
            candidate = self.initial_set_point
            reason = "nominal_reset"

        next_input = self._clamp(candidate)

        if self.critical_load_limit is not None and next_input > self.critical_load_limit:
            self.system_halt = True
            self.current_input = self.min_input
            return {
                "state": "SystemHalt",
                "next_command_input": self.current_input,
                "reason": "critical_load_limit_exceeded",
            }

        self.current_input = next_input
        return {
            "state": "Running",
            "next_command_input": self.current_input,
            "reason": reason,
        }

    def reset(self):
        self.system_halt = False
        self.power_saving_mode = False
        self.low_efficiency_streak = 0
        self.current_input = self.initial_set_point
        self.last_efficiency = None
        self.cycle = 0

    def get_state(self):
        return {
            "current_input": self.current_input,
            "last_efficiency": self.last_efficiency,
            "cycle": self.cycle,
            "warmup_period": self.warmup_period,
            "system_halt": self.system_halt,
            "power_saving_mode": self.power_saving_mode,
            "low_efficiency_streak": self.low_efficiency_streak,
            "signal_integrity_floor": self.signal_integrity_floor,
            "signal_integrity_cycles": self.signal_integrity_cycles,
            "critical_load_limit": self.critical_load_limit,
        }

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# --- SYSTEM CONFIGURATION ---
STATE_FILE = "telemetry_state.json"
BASE_ALLOCATION = 200.0  # Initial Resource Units
target_efficiency = 1.50 # Efficiency Set-Point

# Global State Variables
current_integrity = 0.0
session_start_integrity = 0.0
signal_history = []
operational_streak = 0
current_allocation = BASE_ALLOCATION

def load_system_state():
    global current_integrity, session_start_integrity, signal_history, operational_streak
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                data = json.load(f)
                current_integrity = data.get("current_integrity", 0.0)
                signal_history = data.get("history", [])
                operational_streak = data.get("streak", 0)
        except Exception as e: print(f"Init Error: {e}")

def save_system_state():
    with open(STATE_FILE, "w") as f:
        json.dump({
            "current_integrity": current_integrity,
            "history": signal_history,
            "streak": operational_streak
        }, f)

# --- DYNAMIC RISK & ALLOCATION ENGINE ---
def calculate_resource_scaling(history, integrity):
    """
    Implements Compensatory Scaling (Inverse Gain) to recover system balance.
    """
    global current_allocation
    
    if len(history) < 3:
        return "INITIALIZING...", BASE_ALLOCATION, 0.0

    # 1. Terminal State Detection (Repeated Low Values)
    if all(x < 1.30 for x in history[:3]):
        return "⚠️ CRITICAL_JITTER - HALT", 0.0, 0.0

    # 2. Post-Peak Cooling
    if history[0] > 10.0:
        return "💤 COOLING_CYCLE", 0.0, 0.0

    # 3. COMPENSATORY LOGIC (The Martingale Bypass)
    # If the last signal failed to reach the efficiency target:
    if history[0] < target_efficiency:
        # Scale input to compensate for previous efficiency loss
        current_allocation *= 2.0 
        status = "🔄 COMPENSATING"
    else:
        # System Nominal: Reset to base allocation
        current_allocation = BASE_ALLOCATION
        status = "✅ NOMINAL_FLOW"

    return status, current_allocation, target_efficiency

# --- TELEMETRY ROUTES ---

@app.route('/signal', methods=['POST'])
def process_telemetry():
    """
    High-speed endpoint for WebSocket 'Heavy Packet' interception.
    """
    global signal_history, operational_streak, current_integrity
    
    data = request.get_json(force=True)
    if not data: return jsonify({"status": "no_data"}), 400

    # Capture the Terminal Value (The Crash Point)
    terminal_value = float(data.get('raw', 0.0))
    
    if not signal_history or terminal_value != signal_history[0]:
        signal_history.insert(0, terminal_value)
        if len(signal_history) > 50: signal_history.pop()
        
        # Update streak based on efficiency target
        if terminal_value >= target_efficiency:
            operational_streak += 1
        else:
            operational_streak = 0
            
        save_system_state()

    status, allocation, target = calculate_resource_scaling(signal_history, current_integrity)

    return jsonify({
        "status": status,
        "allocation_units": f"{allocation:,.0f} UGX",
        "target_set_point": f"{target}x",
        "streak": operational_streak
    })

@app.route('/get_stats', methods=['GET'])
def get_stats():
    status, allocation, target = calculate_resource_scaling(signal_history, current_integrity)
    return jsonify({
        "balance": f"{current_integrity:,.2f} UGX",
        "history": signal_history[:10],
        "decision": status,
        "next_stake": f"{allocation:,.0f} UGX",
        "next_exit": f"{target}x",
        "streak": operational_streak
    })

if __name__ == '__main__':
    load_system_state()
    app.run(host='127.0.0.1', port=5000, threaded=True)