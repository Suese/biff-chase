// Procedural audio via WebAudio. No samples — every sound is synthesized:
//   - Engine drone: continuous sawtooth + lowpass, frequency driven by speed.
//   - Tire skid: filtered noise burst.
//   - Collision thump: short low-freq sine with quick decay.
//   - Mine boom: filtered noise with envelope.
//   - Pickup chime: 2-tone bell.
//   - Countdown beeps: short sine pings.

export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.engineNodes = null; // for our local car
  }

  ensure() {
    if (this.ctx) return this.ctx;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.ctx;
  }
  resume() { try { this.ensure().resume(); } catch {} }
  setMuted(m) { this.muted = m; if (m && this.engineNodes) this.engineNodes.gain.gain.value = 0; }

  _envGain(t0, sustain, attack = 0.005, decay = 0.04, release = 0.1, peak = 0.4) {
    const ctx = this.ensure();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.5), t0 + attack + decay);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + sustain + release);
    return g;
  }

  beep(freq = 880, dur = 0.12, type = 'sine', peak = 0.25) {
    if (this.muted) return;
    const ctx = this.ensure();
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this._envGain(t0, dur, 0.003, 0.05, 0.08, peak);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.2);
  }

  pickup() {
    if (this.muted) return;
    this.beep(900, 0.08, 'sine', 0.3);
    setTimeout(() => this.beep(1320, 0.1, 'sine', 0.25), 60);
  }

  scrap() {
    if (this.muted) return;
    this.beep(740, 0.06, 'square', 0.18);
  }

  mineBoom() {
    if (this.muted) return;
    const ctx = this.ensure();
    const t0 = ctx.currentTime;
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    noise.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.value = 0.7;
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
    noise.connect(lp).connect(g).connect(ctx.destination);
    noise.start(t0);
  }

  collide(intensity = 0.5) {
    if (this.muted) return;
    const ctx = this.ensure();
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(180, t0);
    osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.15);
    const g = this._envGain(t0, 0.05, 0.001, 0.02, 0.13, Math.min(0.4, 0.15 + intensity * 0.3));
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.3);
  }

  skid() {
    if (this.muted) return;
    const ctx = this.ensure();
    const t0 = ctx.currentTime;
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.18, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 6;
    const g = this._envGain(t0, 0.1, 0.005, 0.04, 0.06, 0.18);
    noise.connect(bp).connect(g).connect(ctx.destination);
    noise.start(t0);
  }

  // Continuous tire screech while drifting. setDriftLevel(0..1) ramps the
  // intensity; passing 0 silences it. Internally we loop a noise buffer
  // through a bandpass; gain.value follows the drift coefficient with a
  // short ramp so transitions don't pop.
  setDriftLevel(level) {
    const lvl = Math.max(0, Math.min(1, level || 0));
    if (lvl < 0.02) {
      if (this.skidNode) this.skidNode.gain.gain.value = 0;
      return;
    }
    if (!this.skidNode) {
      const ctx = this.ensure();
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2500;
      bp.Q.value = 6;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(bp).connect(gain).connect(ctx.destination);
      src.start();
      this.skidNode = { src, bp, gain };
    }
    const target = this.muted ? 0 : Math.min(0.22, lvl * 0.22);
    const ctx = this.skidNode.gain.context;
    this.skidNode.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.06);
    // Slight frequency shift with drift intensity for variety.
    this.skidNode.bp.frequency.setTargetAtTime(1900 + lvl * 1200, ctx.currentTime, 0.1);
  }

  countdown(n) {
    if (this.muted) return;
    this.beep(n === 0 ? 1320 : 660, 0.18, 'sine', n === 0 ? 0.4 : 0.3);
  }

  // Engine drone — quieter (~¼ of the previous level) and an octave lower
  // so it sits underneath the action instead of sawing through it.
  startEngine() {
    if (this.engineNodes) return;
    const ctx = this.ensure();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 35;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const gain = ctx.createGain();
    gain.gain.value = this.muted ? 0 : 0.02;
    osc.connect(lp).connect(gain).connect(ctx.destination);
    osc.start();
    this.engineNodes = { osc, lp, gain };
  }
  stopEngine() {
    if (!this.engineNodes) return;
    try { this.engineNodes.osc.stop(); } catch {}
    this.engineNodes = null;
  }
  setEngine(speedKMH, boost) {
    if (!this.engineNodes) return;
    // Octave-down range: 35–155 Hz, +30 on boost.
    const baseFreq = 35 + Math.min(1, speedKMH / 240) * 120 + (boost ? 30 : 0);
    this.engineNodes.osc.frequency.value = baseFreq;
    this.engineNodes.lp.frequency.value = 600 + Math.min(1, speedKMH / 240) * 1800;
    // ¼ of the previous gain (was 0.04–0.11).
    this.engineNodes.gain.gain.value = this.muted
      ? 0
      : (0.010 + Math.min(1, speedKMH / 240) * 0.018);
  }
}
