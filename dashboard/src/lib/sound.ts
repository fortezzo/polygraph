// The optional sounds (PLAN.md section 8): a quiet needle scratch and a stamp thud.
// They're off every time the page opens, and only the Sound button turns them on.
// The browser makes them itself, so there are no audio files, and nothing
// audio-related is created until that first click (browsers only allow sound
// after one).
//
// Session 11 redesign, made to work on phone and laptop speakers, which can
// barely play anything under about 150-300 Hz:
// - The thud has three layers: the body of the stamp hitting the desk (a short,
//   falling tone with harmonics small speakers can play), a wooden knock, and the
//   crisp slap of rubber on paper.
// - The scratch is a pen on paper: noise with a fibrous, grainy texture, nearly
//   silent while the needle is calm, louder and brighter when it moves fast.
// - Both stay quiet. scripts/sound-lab.mjs renders them and measures their levels.
//
// On an iPhone, web sounds are muted by the silent switch unless the page asks for
// "playback". Turning Sound on asks for it, since the viewer asked for sound
// (Christian, Session 11). Turning it off gives the setting back.

/** Peak levels the sounds are tuned to (scripts/sound-lab.mjs checks them). */
export const LEVELS = {
  master: 0.7,
  thud: 0.42,
  scratch: 0.07,
};

type AnyContext = BaseAudioContext;

/** Two seconds of paper: noise whose loudness flickers with the paper's fibers. */
export function paperNoise(ctx: AnyContext, seed = 7): AudioBuffer {
  const len = Math.round(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // A small, seeded random generator, so every page makes the same paper.
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  // The fibers: a random level about 220 times a second, smoothed, then sharpened,
  // so the scratch catches and releases like a nib on paper.
  const step = Math.round(ctx.sampleRate / 220);
  let from = rand();
  let to = rand();
  for (let i = 0; i < len; i++) {
    if (i % step === 0) {
      from = to;
      to = rand();
    }
    const k = (i % step) / step;
    const fiber = from + (to - from) * (k * k * (3 - 2 * k));
    const grain = 0.3 + 0.7 * fiber ** 2.2;
    data[i] = (rand() * 2 - 1) * grain;
  }
  // Fade the loop's ends into each other, so the loop never clicks.
  const fade = Math.round(ctx.sampleRate * 0.02);
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    data[i] = data[i]! * a + data[len - fade + i]! * (1 - a);
  }
  return buf;
}

/** How loud and how bright the scratch is for the pen's speed, from 0 (still) to 1 (a spike). */
export function scratchShape(level: number): { gain: number; freq: number } {
  const v = Math.max(0, Math.min(1, level));
  // A power over 1 keeps the calm line's small wiggles nearly silent.
  return { gain: LEVELS.scratch * v ** 1.35, freq: 2300 + 2600 * v };
}

export interface ScratchChain {
  gain: GainNode;
  band: BiquadFilterNode;
  stop: () => void;
}

/** The scratch: looping paper noise, thinned to the pen's range. Silent until scratch() sets its level. */
export function scratchInto(ctx: AnyContext, noise: AudioBuffer, out: AudioNode): ScratchChain {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const high = ctx.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 1100;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 2300;
  band.Q.value = 0.85;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(high).connect(band).connect(gain).connect(out);
  src.start();
  return { gain, band, stop: () => src.stop() };
}

/** The stamp landing at `when` (seconds, on the context's clock). */
export function thudInto(ctx: AnyContext, noise: AudioBuffer, out: AudioNode, when: number): void {
  const bus = ctx.createGain();
  bus.gain.value = LEVELS.thud;
  bus.connect(out);

  // 1. The body: a falling tone. A triangle wave carries harmonics at 3 and 5 times
  // the pitch, which small speakers can play even when they can't play the pitch.
  const body = ctx.createOscillator();
  body.type = "triangle";
  body.frequency.setValueAtTime(190, when);
  body.frequency.exponentialRampToValueAtTime(78, when + 0.11);
  const bodyTone = ctx.createBiquadFilter();
  bodyTone.type = "lowpass";
  bodyTone.frequency.value = 1400;
  const bodyGain = ctx.createGain();
  bodyGain.gain.setValueAtTime(0.0001, when);
  bodyGain.gain.exponentialRampToValueAtTime(0.85, when + 0.004);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
  body.connect(bodyTone).connect(bodyGain).connect(bus);
  body.start(when);
  body.stop(when + 0.22);

  // 2. The knock: a short, woody burst around 600 Hz.
  const knock = ctx.createBufferSource();
  knock.buffer = noise;
  const knockBand = ctx.createBiquadFilter();
  knockBand.type = "bandpass";
  knockBand.frequency.value = 620;
  knockBand.Q.value = 1.6;
  const knockGain = ctx.createGain();
  knockGain.gain.setValueAtTime(0.0001, when);
  knockGain.gain.exponentialRampToValueAtTime(1.4, when + 0.002);
  knockGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
  knock.connect(knockBand).connect(knockGain).connect(bus);
  knock.start(when, 0.31);
  knock.stop(when + 0.08);

  // 3. The slap of rubber on paper: very short and bright.
  const slap = ctx.createBufferSource();
  slap.buffer = noise;
  const slapHigh = ctx.createBiquadFilter();
  slapHigh.type = "highpass";
  slapHigh.frequency.value = 2400;
  const slapGain = ctx.createGain();
  slapGain.gain.setValueAtTime(0.0001, when);
  slapGain.gain.exponentialRampToValueAtTime(0.32, when + 0.0015);
  slapGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
  slap.connect(slapHigh).connect(slapGain).connect(bus);
  slap.start(when, 0.77);
  slap.stop(when + 0.04);
}

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

/** Ask iPhones to play web sound even on silent (Safari 17 and later), or give the setting back. */
function audioSession(type: "playback" | "auto"): void {
  const session = (navigator as AudioSessionNavigator).audioSession;
  if (!session) return;
  try {
    session.type = type;
  } catch {
    // An older browser: nothing to change.
  }
}

export class Sound {
  enabled = false;
  contextCreated = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private chain: ScratchChain | null = null;

  enable(): void {
    audioSession("playback");
    if (!this.ctx) this.build();
    void this.ctx?.resume().catch(() => {});
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
    this.quiet();
    void this.ctx?.suspend().catch(() => {});
    audioSession("auto");
  }

  /** The scratch follows how fast the pen is moving, from 0 to 1. */
  scratch(level: number): void {
    if (!this.enabled || !this.ctx || !this.chain) return;
    const { gain, freq } = scratchShape(level);
    const now = this.ctx.currentTime;
    this.chain.gain.gain.setTargetAtTime(gain, now, 0.035);
    this.chain.band.frequency.setTargetAtTime(freq, now, 0.05);
  }

  quiet(): void {
    if (!this.ctx || !this.chain) return;
    this.chain.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
  }

  thud(): void {
    if (!this.enabled || !this.ctx || !this.master || !this.noise) return;
    thudInto(this.ctx, this.noise, this.master, this.ctx.currentTime + 0.005);
  }

  private build(): void {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.contextCreated = true;
    this.master = ctx.createGain();
    this.master.gain.value = LEVELS.master;
    this.master.connect(ctx.destination);
    this.noise = paperNoise(ctx);
    this.chain = scratchInto(ctx, this.noise, this.master);
  }
}
