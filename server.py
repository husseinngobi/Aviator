from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import base64
import re
import json
import os
from datetime import datetime

app = Flask(__name__)
# Enable CORS for all routes and origins
CORS(app, resources={r"/*": {"origins": "*"}})

# --- CONFIGURATION ---
STATE_FILE = "session_data.json"
LOG_FILE = "crash_log.txt"

# Global Variables
current_balance = 0.0
session_start_balance = 0.0
all_crashes = []
win_streak = 0

# --- CORE UTILITIES ---
def save_state():
    with open(STATE_FILE, "w") as f:
        json.dump({
            "start_balance": session_start_balance,
            "current_balance": current_balance
        }, f)

def log_crash(multiplier):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_FILE, "a") as f:
        f.write(f"[{timestamp}] CRASH: {multiplier}x\n")

# --- AI STRATEGY ENGINE ---
def get_ai_strategy(history, balance):
    if len(history) < 3:
        return "SYNCING HISTORY...", 0, 0.00
    
    avg_10 = sum(history[-10:]) / len(history[-10:]) if history else 0
    
    # 1. TRAP DETECTION
    if len(history) >= 3 and all(x < 1.30 for x in history[-3:]):
        return "⚠️ TRAP - WAIT", 0, 0.00
    
    # 2. COOL DOWN
    if history and history[-1] > 10.0:
        return "💤 COOLING DOWN", 0, 0.00

    # 3. MONEY MANAGEMENT (2% Stake)
    stake = int(balance * 0.02)
    if stake < 200: stake = 200 

    # 4. PREDICTIONS
    if avg_10 < 1.8:
        exit_point, decision = 1.30, "🔵 SCALPING"
    elif avg_10 > 2.5:
        exit_point, decision = 2.00, "🔥 BULLISH"
    else:
        exit_point, decision = 1.50, "✅ SAFE ENTRY"

    return decision, stake, exit_point

# --- ROUTES ---

@app.route('/')
def serve_dashboard():
    """Serves the dashboard.html from the same folder as this script"""
    return send_from_directory(os.getcwd(), 'dashboard.html')

@app.route('/balance', methods=['POST', 'OPTIONS'])
def update_balance():
    global current_balance, session_start_balance
    if request.method == 'OPTIONS': return jsonify({"ok": True}), 200
    
    data = request.get_json(force=True, silent=True)
    if data and 'balance' in data:
        new_val = float(data['balance'])
        if session_start_balance == 0: session_start_balance = new_val
        current_balance = new_val
        save_state()
        return jsonify({"status": "synced", "wallet": current_balance}), 200
    return jsonify({"status": "error"}), 400

@app.route('/data', methods=['POST', 'OPTIONS'])
def receive_data():
    global all_crashes, win_streak
    if request.method == 'OPTIONS': return jsonify({"ok": True}), 200

    payload = request.get_json(force=True, silent=True)
    if not payload or 'raw' not in payload:
        return jsonify({"status": "waiting"}), 200

    try:
        raw_val = payload.get('raw', '')
        # Handle both base64 and plain text
        try:
            decoded = base64.b64decode(raw_val).decode('utf-8')
        except:
            decoded = raw_val

        found = re.findall(r'[1-9]\d?\.\d{2}', decoded)

        if found:
            latest = float(found[-1])
            if not all_crashes or latest != all_crashes[-1]:
                log_crash(latest)
                all_crashes.append(latest)
                if len(all_crashes) > 30: all_crashes.pop(0)
                
                # Update Streak
                _, _, last_target = get_ai_strategy(all_crashes[:-1], current_balance)
                if latest >= last_target and last_target > 0: win_streak += 1
                else: win_streak = 0

        decision, stake, exit_p = get_ai_strategy(all_crashes, current_balance)
        session_profit = current_balance - session_start_balance

        return jsonify({
            "status": "success",
            "latest_crash": all_crashes[-1] if all_crashes else "0.00",
            "decision": decision,
            "suggested_bet": f"{stake} UGX",
            "cashout_at": f"{exit_p}x",
            "session_profit": f"{session_profit:,.0f} UGX",
            "streak": win_streak
        }), 200

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 200

@app.route('/get_stats', methods=['GET'])
def get_stats():
    decision, stake, exit_p = get_ai_strategy(all_crashes, current_balance)
    session_profit = current_balance - session_start_balance
    return jsonify({
        "balance": current_balance,
        "profit": session_profit,
        "last_crash": all_crashes[-1] if all_crashes else 0,
        "streak": win_streak,
        "history": all_crashes[-10:],
        "decision": decision,
        "next_stake": f"{stake} UGX",
        "next_exit": f"{exit_p}x"
    })

if __name__ == '__main__':
    print(f"🚀 AI Engine Online: http://127.0.0.1:5000")
    app.run(host='127.0.0.1', port=5000, debug=False)