// The optional sounds: a quiet needle scratch and a stamp thud. Off until the
// viewer turns them on. The browser makes them itself, so there are no audio
// files. Nothing audio-related is created until the first time sound is turned
// on, because browsers only allow sound after a click.

export class Sound {
  enabled = false;
  contextCreated = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private scratchGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  enable(): void {
    if (!this.ctx) this.build();
    void this.ctx?.resume();
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
    this.quiet();
    void this.ctx?.suspend();
  }

  /** The scratch follows how fast the pen is moving, from 0 to 1. */
  scratch(level: number): void {
    if (!this.enabled || !this.ctx || !this.scratchGain) return;
    const v = 0.004 + 0.045 * Math.max(0, Math.min(1, level));
    this.scratchGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.04);
  }

  quiet(): void {
    if (!this.ctx || !this.scratchGain) return;
    this.scratchGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
  }

  thud(): void {
    if (!this.enabled || !this.ctx || !this.master || !this.noise) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // The body of the thud: a low tone that drops in pitch.
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(92, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.22);
    og.gain.setValueAtTime(0.0001, now);
    og.gain.exponentialRampToValueAtTime(0.9, now + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    osc.connect(og).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.36);
    // The slap of rubber on paper: a short burst of muffled noise.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.55, now);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    src.connect(lp).connect(ng).connect(this.master);
    src.start(now);
    src.stop(now + 0.1);
  }

  private build(): void {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.contextCreated = true;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);
    // Two seconds of noise, reused by both sounds.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    // The scratch: looping noise, filtered thin like a pen on paper.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600;
    bp.Q.value = 0.9;
    this.scratchGain = ctx.createGain();
    this.scratchGain.gain.value = 0;
    src.connect(bp).connect(this.scratchGain).connect(this.master);
    src.start();
  }
}
