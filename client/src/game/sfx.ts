// Tiny WebAudio synthesizer: original procedural sounds, nothing to download.

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private jetGain: GainNode | null = null;
  private lastShot = 0;
  enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
  }

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 0.5;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  private burst(freq: number, q: number, dur: number, vol: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.noise || !this.master || ctx.state !== 'running') return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.3, dur + 0.02);
  }

  private tone(freq: number, to: number, dur: number, vol: number, type: OscillatorType = 'square'): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const o = ctx.createOscillator();
    o.type = type;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** `vol` 0..1 already includes distance attenuation. */
  shot(weapon: number, vol: number): void {
    const now = performance.now();
    if (vol < 0.03 || now - this.lastShot < 25) return; // cap voices
    this.lastShot = now;
    const freq = [1400, 1100, 600, 900, 300][weapon] ?? 1200;
    this.burst(freq, 0.9, weapon === 2 || weapon === 4 ? 0.25 : 0.11, 0.9 * vol);
  }

  hit(): void {
    this.tone(1800, 1200, 0.05, 0.12, 'triangle');
  }

  hurt(): void {
    this.burst(300, 1.5, 0.12, 0.5);
  }

  kill(): void {
    this.tone(880, 440, 0.18, 0.12);
  }

  empty(): void {
    this.tone(500, 480, 0.03, 0.08);
  }

  /** Continuous jet hiss for the local player (0 = off). */
  jet(level: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.master || ctx.state !== 'running') return;
    if (!this.jetGain) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 700;
      this.jetGain = ctx.createGain();
      this.jetGain.gain.value = 0;
      src.connect(f).connect(this.jetGain).connect(this.master);
      src.start();
    }
    this.jetGain.gain.setTargetAtTime(level * 0.18, ctx.currentTime, 0.04);
  }

  mute(): void {
    this.jet(0);
  }
}
