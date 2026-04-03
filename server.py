from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import base64
import re
import json
import os
from datetime import datetime

app = Flask(__name__)
# Robust CORS configuration for local development
CORS(app, resources={r"/*": {"origins": "*"}})

# --- CONFIGURATION ---
STATE_FILE = "session_data.json"
LOG_FILE = "crash_log.txt"
MIN_ANALYSIS_POINTS = 5

# Global Variables
current_balance = 0.0
session_start_balance = 0.0
all_crashes = []
win_streak = 0

# --- CORE UTILITIES ---
def load_state():
    global current_balance, session_start_balance, all_crashes, win_streak

    if not os.path.exists(STATE_FILE):
        return

    try:
        with open(STATE_FILE, "r") as f:
            data = json.load(f)

        session_start_balance = float(data.get("start_balance", 0.0) or 0.0)
        current_balance = float(data.get("current_balance", 0.0) or 0.0)
        all_crashes = list(data.get("history", []) or [])
        win_streak = int(data.get("win_streak", 0) or 0)
        print(f"Loaded session state: {len(all_crashes)} rounds, balance {current_balance}")
    except Exception as e:
        print(f"Load Error: {e}")

def save_state():
    try:
        with open(STATE_FILE, "w") as f:
            json.dump({
                "start_balance": session_start_balance,
                "current_balance": current_balance,
                "history": all_crashes,
                "win_streak": win_streak
            }, f)
    except Exception as e:
        print(f"Save Error: {e}")

def log_crash(multiplier):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_FILE, "a") as f:
        f.write(f"[{timestamp}] CRASH: {multiplier}x\n")

# --- AI STRATEGY ENGINE ---
def get_ai_strategy(history, balance):
    if len(history) < MIN_ANALYSIS_POINTS:
        return "SYNCING HISTORY...", 0, 0.00
    
    # Analyze recent trend
    recent_history = history[-10:]
    avg_10 = sum(recent_history) / len(recent_history) if recent_history else 0
    
    # 1. TRAP DETECTION (Several low numbers)
    if all(x < 1.30 for x in history[-3:]):
        return "⚠️ TRAP - WAIT", 0, 0.00
    
    # 2. RECENT BIG WIN COOLING
    if history[-1] > 10.0:
        return "💤 COOLING DOWN", 0, 0.00

    # 3. STAKE CALCULATION (2% of actual balance)
    stake = int(balance * 0.02)
    if stake < 200: stake = 200 

    # 4. ENTRY LOGIC
    if avg_10 < 1.8:
        exit_point, decision = 1.35, "🔵 SCALPING"
    elif avg_10 > 2.5:
        exit_point, decision = 2.00, "🔥 BULLISH"
    else:
        exit_point, decision = 1.50, "✅ SAFE ENTRY"

    return decision, stake, exit_point

# --- ROUTES ---

@app.route('/')
def serve_dashboard():
    return send_from_directory(os.getcwd(), 'dashboard.html')

@app.route('/data', methods=['POST', 'OPTIONS'])
def receive_data():
    global all_crashes, win_streak, current_balance, session_start_balance
    
    if request.method == 'OPTIONS': 
        return jsonify({"ok": True}), 200

    payload = request.get_json(force=True, silent=True)
    if not payload: 
        return jsonify({"status": "waiting"}), 200

    # --- 1. SANITIZED BALANCE PROCESSING ---
    if 'balance' in payload:
        try:
            # Defensive: Clean the balance string of any non-numeric junk
            raw_bal = str(payload['balance'])
            clean_bal = re.search(r'\d+\.\d{2}', raw_bal)
            
            if clean_bal:
                new_bal = float(clean_bal.group())
            else:
                # Fallback if regex fails, just take first digits
                new_bal = float(''.join(filter(lambda x: x.isdigit() or x == '.', raw_bal)))
            
            if session_start_balance == 0: 
                session_start_balance = new_bal
            current_balance = new_bal
        except Exception as e:
            print(f"Balance Parse Error: {e}")

    # --- 2. PROCESS CRASH HISTORY ---
    if 'raw' in payload:
        try:
            raw_val = str(payload.get('raw', ''))
            
            # Base64 decode if necessary, otherwise use raw
            try: 
                decoded = base64.b64decode(raw_val).decode('utf-8')
            except: 
                decoded = raw_val

            # Improved Regex: finds numbers like 1.00, 10.55, 100.00
            found = re.findall(r'\d+\.\d{2}', decoded)

            if found:
                # Convert found strings to floats
                incoming_floats = [float(f) for f in found]
                latest = incoming_floats[0] # Assuming newest is first

                # Only log and update if it's a new round result
                if not all_crashes or latest != all_crashes[0]:
                    log_crash(latest)
                    all_crashes.insert(0, latest) # Insert at start for history tracking
                    if len(all_crashes) > 30: 
                        all_crashes.pop()
                    
                    # Logic for Streak Tracking
                    _, _, last_target = get_ai_strategy(all_crashes[1:], current_balance)
                    if latest >= last_target and last_target > 0: 
                        win_streak += 1
                    else: 
                        win_streak = 0
                    
                    save_state()
        except Exception as e:
            print(f"History Scrape Error: {e}")

    # Calculate current strategy for response
    decision, stake, exit_p = get_ai_strategy(all_crashes, current_balance)
    session_profit = current_balance - session_start_balance

    return jsonify({
        "status": "success",
        "latest_crash": all_crashes[0] if all_crashes else "0.00",
        "decision": decision,
        "suggested_bet": f"{stake:,} UGX",
        "cashout_at": f"{exit_p}x",
        "session_profit": f"{session_profit:,.0f} UGX",
        "streak": win_streak
    }), 200

@app.route('/get_stats', methods=['GET'])
def get_stats():
    decision, stake, exit_p = get_ai_strategy(all_crashes, current_balance)
    return jsonify({
        "balance": f"{current_balance:,.2f} UGX",
        "profit": f"{current_balance - session_start_balance:,.2f} UGX",
        "history": all_crashes[:10],
        "decision": decision,
        "streak": win_streak,
        "next_stake": f"{stake:,} UGX",
        "next_exit": f"{exit_p}x",
        "analysis_ready": len(all_crashes) >= MIN_ANALYSIS_POINTS,
        "samples": len(all_crashes)
    })

if __name__ == '__main__':
    # Using threaded=True to handle multiple rapid requests from the scraper
    load_state()
    app.run(host='127.0.0.1', port=5000, debug=False, threaded=True)