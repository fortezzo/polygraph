// How far the chart paper has moved by each moment of a replay (Session 11).
//
// The paper used to move at one steady speed. On a phone, by the time a caught
// answer's verdict and confidence showed, its red spike and CAUGHT stamp had
// already scrolled off the left edge (Christian's note after Session 7). Now,
// after a stamp lands, the paper slows down just enough that the whole stamp is
// still on the paper until a little after the confidence shows, then speeds back
// up before the next question. Where there's room (a laptop), it never slows.
//
// The paper's position is a function of time only, so seeking, pausing and every
// speed of the replay see the same paper.

import type { Timeline } from "./timeline";
import { HOUSING, TILT_ROOM } from "./stamp";

export interface PaperMotion {
  /** Pixels of paper that have gone past the pen by time t (ms). */
  pos(t: number): number;
  /** The moment the paper had moved `p` pixels: the inverse of pos. */
  timeAt(p: number): number;
  /** Pixels the paper moves from time a to time b. */
  shift(a: number, b: number): number;
}

/** How long the stamp stays fully on the paper after the confidence shows. */
export const HOLD_AFTER = 2500;
/** How long the paper takes to slow down after the stamp lands, and to speed back up. */
export const RAMP_DOWN = 350;
export const RAMP_UP = 600;
/**
 * The longest the paper holds a stamp in view (ms). A consistency trap's verdict
 * comes with its first chat, and its confidence only after the fourth, about 45
 * seconds later: holding the paper that long would crawl it and cram the trace.
 */
export const MAX_HOLD = 14_000;
/** The pen keeps drawing, so the paper never stops altogether (pixels a second). */
export const SLOWEST = 4;
/** How close to the paper's left edge the stamp may come. */
export const MARGIN = 6;

/** A stretch where the speed changes linearly from v0 to v1 (pixels a millisecond). */
interface Segment {
  t0: number;
  t1: number;
  v0: number;
  v1: number;
  /** The paper's position at t0. */
  p0: number;
}

class Motion implements PaperMotion {
  private readonly segs: Segment[];
  constructor(
    private readonly base: number, // pixels a millisecond
    changes: { t0: number; t1: number; v0: number; v1: number }[],
  ) {
    // Position at each segment's start: the steady speed, plus what every earlier
    // segment gained or lost against it.
    let extra = 0;
    this.segs = changes
      .slice()
      .sort((a, b) => a.t0 - b.t0)
      .map((c) => {
        const seg: Segment = { ...c, p0: base * c.t0 + extra };
        const dur = c.t1 - c.t0;
        extra += ((c.v0 + c.v1) / 2) * dur - base * dur;
        return seg;
      });
  }

  /** Whether the paper ever changes speed. */
  get steady(): boolean {
    return this.segs.length === 0;
  }

  private find(t: number): number {
    // The last segment that starts at or before t.
    let lo = 0;
    let hi = this.segs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.segs[mid]!.t0 <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  pos(t: number): number {
    const i = this.find(t);
    if (i < 0) return this.base * t;
    const s = this.segs[i]!;
    if (t >= s.t1) {
      const end = s.p0 + ((s.v0 + s.v1) / 2) * (s.t1 - s.t0);
      return end + this.base * (t - s.t1);
    }
    const dt = t - s.t0;
    const v = s.v0 + ((s.v1 - s.v0) * dt) / (s.t1 - s.t0);
    return s.p0 + ((s.v0 + v) / 2) * dt;
  }

  timeAt(p: number): number {
    if (this.steady) return p / this.base;
    // pos only ever grows, so a binary search finds the moment.
    let lo = -1e7;
    let hi = Math.max(1, p / this.base) + 1e7;
    for (let k = 0; k < 60 && hi - lo > 0.05; k++) {
      const mid = (lo + hi) / 2;
      if (this.pos(mid) < p) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  shift(a: number, b: number): number {
    return this.pos(b) - this.pos(a);
  }
}

/** Paper at one steady speed, in pixels a second (live mode, and the old behavior). */
export function steadyPaper(speed: number): PaperMotion {
  return new Motion(speed / 1000, []);
}

export interface HoldGeometry {
  w: number;
  penX: number;
  /** The steady speed, pixels a second. */
  speed: number;
  /** The CAUGHT stamp's width on this screen, in pixels. */
  stampWidth: number;
}

/**
 * Paper that slows down after each stamp, where it has to, so the stamp stays on
 * the paper until HOLD_AFTER after the confidence shows (the "final" moment).
 */
export function heldPaper(timeline: Timeline, g: HoldGeometry): PaperMotion {
  const v0 = g.speed / 1000;
  const changes: { t0: number; t1: number; v0: number; v1: number }[] = [];
  for (const p of timeline.traps) {
    if (p.stampAt === null) continue;
    const at = p.stampAt;
    const holdEnd = Math.min(p.finalAt + HOLD_AFTER, at + MAX_HOLD);
    // Where the stamp's left edge lands, at the steady speed (as stamp.ts places it).
    const landX = (tau: number) => g.penX - (at - tau) * v0;
    const s0 = p.spike?.start ?? at;
    const s1 = p.spike?.end ?? at;
    let left = (landX(s0) + landX(s1)) / 2 - g.stampWidth / 2;
    left = Math.min(left, g.w - HOUSING - TILT_ROOM - g.stampWidth);
    left = Math.max(left, landX(p.start) + TILT_ROOM);
    // The slow-down starts once the spike is drawn (a short phrase's spike runs on a
    // moment after the stamp lands), so the stamp lands exactly where it always did.
    const from = Math.max(at, p.spike?.end ?? at);
    const room = left - MARGIN - v0 * (from - at); // how far it may still travel before it starts leaving the paper
    const T = holdEnd - from;
    if (T <= RAMP_DOWN || room <= 0) continue;
    // At the steady speed it would travel v0 * T. If that's too far, find the slower
    // speed v1 with: ramp down (average (v0 + v1) / 2) for RAMP_DOWN, then v1 until holdEnd.
    if (v0 * T <= room) continue;
    const v1 = Math.max(SLOWEST / 1000, (room - (v0 * RAMP_DOWN) / 2) / (T - RAMP_DOWN / 2));
    if (v1 >= v0) continue;
    // Never run into the next question: speed back up before it starts.
    const upEnd = Math.min(holdEnd + RAMP_UP, p.end);
    const upStart = Math.min(holdEnd, upEnd - 1);
    changes.push({ t0: from, t1: from + RAMP_DOWN, v0, v1 });
    if (upStart > from + RAMP_DOWN) changes.push({ t0: from + RAMP_DOWN, t1: upStart, v0: v1, v1 });
    changes.push({ t0: upStart, t1: upEnd, v0: v1, v1: v0 });
  }
  return new Motion(v0, changes);
}
