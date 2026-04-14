class AudioAlertService {
  constructor() {
    this.audioContext = null;
    this.masterGain = null;
    this.activeNodes = [];
    this.lastWarningAt = 0;
    this.warningCooldownMs = 700;
  }

  ensureContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;

    if (!this.audioContext) {
      this.audioContext = new AudioCtx();
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = 0.18;
      this.masterGain.connect(this.audioContext.destination);
    }

    if (this.audioContext.state === "suspended") {
      this.audioContext.resume().catch(() => {});
    }

    return this.audioContext;
  }

  playTone({ frequency, durationMs, type = "sine", gain = 0.2 }) {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);

    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), now + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);

    oscillator.connect(envelope);
    envelope.connect(this.masterGain);

    oscillator.start(now);
    oscillator.stop(now + durationMs / 1000 + 0.02);

    this.activeNodes.push({ oscillator, envelope });
  }

  playJitterWarningBeep() {
    const now = Date.now();
    if (now - this.lastWarningAt < this.warningCooldownMs) return;
    this.lastWarningAt = now;

    this.playTone({ frequency: 620, durationMs: 140, type: "square", gain: 0.14 });
    window.setTimeout(() => {
      this.playTone({ frequency: 520, durationMs: 160, type: "square", gain: 0.12 });
    }, 180);
  }

  playSlaBreachSolidTone() {
    this.playTone({ frequency: 880, durationMs: 500, type: "sawtooth", gain: 0.16 });
  }

  stopAll() {
    for (const node of this.activeNodes) {
      try {
        node.oscillator.stop();
      } catch {
        // no-op
      }
      try {
        node.oscillator.disconnect();
        node.envelope.disconnect();
      } catch {
        // no-op
      }
    }
    this.activeNodes = [];
  }
}

const audioAlertService = new AudioAlertService();

export default audioAlertService;