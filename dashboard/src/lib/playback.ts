// The replay clock: play, pause, restart and jump. It isn't React state, so the
// needle can read it every frame without re-rendering anything.

export type Status = "playing" | "paused" | "ended";

/** What the chart paper needs from a clock: the replay's, or the live screen's (Session 8). */
export interface Clock {
  now(): number;
  readonly status: Status;
  /** How fast it runs (Session 10's speed control). The live screen's is always 1. */
  readonly rate?: number;
}

/** The replay's speeds (Session 10). A whole 200-question recording takes about an hour at 1×. */
export const SPEEDS = [1, 2, 4, 8] as const;

export class Playback {
  private origin = 0;
  private pausedAt: number | null;
  private listeners = new Set<() => void>();

  constructor(
    public readonly duration: number,
    opts: { paused?: boolean; at?: number; rate?: number } = {},
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.rate = opts.rate ?? 1;
    const at = Math.max(0, Math.min(opts.at ?? 0, duration));
    this.pausedAt = opts.paused ? at : null;
    this.origin = this.clock() - at / this.rate;
  }

  rate: number;

  now(): number {
    const t = this.pausedAt ?? (this.clock() - this.origin) * this.rate;
    return Math.max(0, Math.min(t, this.duration));
  }

  get status(): Status {
    if (this.now() >= this.duration) return "ended";
    return this.pausedAt === null ? "playing" : "paused";
  }

  play(): void {
    if (this.pausedAt === null) return;
    const from = this.pausedAt >= this.duration ? 0 : this.pausedAt;
    this.origin = this.clock() - from / this.rate;
    this.pausedAt = null;
    this.emit();
  }

  pause(): void {
    if (this.pausedAt !== null) return;
    this.pausedAt = this.now();
    this.emit();
  }

  seek(t: number): void {
    const to = Math.max(0, Math.min(t, this.duration));
    if (this.pausedAt !== null) this.pausedAt = to;
    else this.origin = this.clock() - to / this.rate;
    this.emit();
  }

  restart(): void {
    this.pausedAt = 0;
    this.play();
  }

  /** A new speed, without a jump: the replay carries on from exactly where it is. */
  setRate(rate: number): void {
    if (!(rate > 0) || rate === this.rate) return;
    const t = this.now();
    this.rate = rate;
    if (this.pausedAt === null) this.origin = this.clock() - t / rate;
    this.emit();
  }

  /** Called every frame: stops the clock cleanly at the end. */
  tick(): void {
    if (this.pausedAt === null && this.now() >= this.duration) {
      this.pausedAt = this.duration;
      this.emit();
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
