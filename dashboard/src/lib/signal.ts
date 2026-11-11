// Where the needle is at any moment. The calm line is decoration: a slow
// breathing wave with a little jitter, flatter while a question is being typed.
// The only meaningful part is the spike, which happens exactly while the
// judge's made-up phrase streams in (see timeline.ts). Same time, same needle:
// it's a pure function, so the replay can jump anywhere and draw the same line.

import type { Timeline, Tone, Window } from "./timeline";

export interface Track {
  quiet: Window[];
  active: Window[];
  spikes: { start: number; end: number; tone: Tone }[];
}

export function trackOf(tl: Timeline): Track {
  return {
    quiet: tl.traps.flatMap((p) => p.quiet),
    active: tl.traps.flatMap((p) => p.active),
    spikes: tl.traps.flatMap((p) => (p.spike ? [p.spike] : [])),
  };
}

const CALM = 0.2; // share of the half-height the calm line uses
const SPIKE = 0.95;
// Spikes swing up fully but only partly down, so they never run into the
// label written under them on the paper.
const DOWN = 0.72;
const EDGE = 250; // ms to ease between quiet, idle and active

function hash(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Smooth noise in [-1, 1]. */
function noise(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (hash(i) * (1 - u) + hash(i + 1) * u) * 2 - 1;
}

// Session 10: a whole interrogation has hundreds of windows, and the chart paper
// asks for hundreds of points every frame. So each list is sorted once (and kept
// for as long as the list itself), and each point only looks at the windows near
// it. The needle draws exactly the same line as before.
interface Sorted<T extends Window> {
  items: T[];
  starts: number[];
  /** The latest end among the first i + 1 items: how far back a long window could still reach. */
  maxEnd: number[];
}

const sortedCache = new WeakMap<readonly Window[], Sorted<Window>>();

function sorted<T extends Window>(ws: readonly T[]): Sorted<T> {
  let s = sortedCache.get(ws) as Sorted<T> | undefined;
  if (!s) {
    const items = [...ws].sort((a, b) => a.start - b.start);
    let m = -Infinity;
    s = { items, starts: items.map((w) => w.start), maxEnd: items.map((w) => (m = Math.max(m, w.end))) };
    sortedCache.set(ws, s as unknown as Sorted<Window>);
  }
  return s;
}

/** The last index whose start is at or before t, or -1. */
function lastStartingBy(starts: number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The items that could matter at time t (start <= t + before, end >= t - after):
 * items[lo..hi], in order. Nothing is copied, since this runs for every point drawn.
 */
function near<T extends Window>(ws: readonly T[], t: number, before: number, after: number): { items: T[]; lo: number; hi: number } {
  const s = sorted(ws);
  const hi = lastStartingBy(s.starts, t + before);
  let lo = hi;
  while (lo > 0 && s.maxEnd[lo - 1]! + after >= t) lo--;
  return { items: s.items, lo: Math.max(lo, 0), hi };
}

function inside(ws: Window[], t: number): number {
  // 1 well inside a window, easing to 0 at its edges.
  let best = 0;
  const { items, lo, hi } = near(ws, t, EDGE, EDGE);
  for (let i = lo; i <= hi; i++) {
    const w = items[i]!;
    if (t < w.start - EDGE || t > w.end + EDGE) continue;
    const a = Math.min(1, (t - (w.start - EDGE)) / EDGE, ((w.end + EDGE) - t) / EDGE);
    if (a > best) best = a;
  }
  return Math.max(0, Math.min(1, best));
}

export interface NeedlePoint {
  /** -1 (bottom) to 1 (top), as a share of the half-height. */
  y: number;
  tone: Tone | null;
}

export function needleAt(track: Track, t: number): NeedlePoint {
  const s = t / 1000;
  const wave =
    0.62 * Math.sin(2 * Math.PI * 0.23 * s + 1.3) +
    0.28 * Math.sin(2 * Math.PI * 1.15 * s + 4.1) +
    0.12 * Math.sin(2 * Math.PI * 2.9 * s + 0.7) +
    0.35 * noise(s * 1.7);
  const q = inside(track.quiet, t);
  const a = inside(track.active, t);
  const level = 0.55 + 0.45 * a - 0.3 * q;
  let y = CALM * level * wave;
  let tone: Tone | null = null;
  const spikes = near(track.spikes, t, 0, 1900);
  for (let i = spikes.lo; i <= spikes.hi; i++) {
    const sp = spikes.items[i]!;
    if (t < sp.start || t > sp.end + 1900) continue;
    const ts = (t - sp.start) / 1000;
    const decay = Math.exp(-ts / 0.55);
    // While the phrase is still streaming in, the needle stays agitated.
    const held = t <= sp.end ? 0.42 : 0;
    const env = Math.max(decay, held);
    let swing: number;
    if (sp.tone === "caved") swing = -Math.sin(2 * Math.PI * 1.6 * ts); // it droops
    else if (sp.tone === "contradicted") swing = Math.sin(2 * Math.PI * 3.3 * ts); // it zigzags
    else swing = Math.sin(2 * Math.PI * 2.1 * ts);
    const v = SPIKE * env * (swing + 0.18 * Math.sin(2 * Math.PI * 9 * ts));
    y += v < 0 ? v * DOWN : v;
    if (t <= sp.end + 400 || ts < 1.6) tone = sp.tone;
  }
  return { y: Math.max(-1, Math.min(1, y)), tone };
}
