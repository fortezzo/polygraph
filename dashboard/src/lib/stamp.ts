// Where the CAUGHT stamp sits on the chart paper (Christian's fix, Session 6).
// It lands on the spike it belongs to, centered on the made-up words. At the
// moment it lands it never reaches back over the previous question's paper and
// never goes under the machine housing. After that it rides with the paper.

export const HOUSING = 34; // the housing's left edge, measured from the paper's right edge
export const TILT_ROOM = 8; // a tilted stamp reaches a little past its own box

export interface StampPlan {
  start: number; // when the question started
  spike: { start: number; end: number } | null;
  stampAt: number | null;
}

/**
 * Moving paper: the pen stays at penX and the paper moves left at `speed` pixels a
 * second. Session 11: or, given `shift`, by however far the paper moved between two
 * moments (it slows down after a stamp on a phone, see paper.ts).
 */
export interface MovingPaper {
  w: number;
  penX: number;
  speed: number;
  shift?: (from: number, to: number) => number;
}

/** The stamp's left edge on moving paper at time t, in pixels. */
export function stampX(plan: StampPlan, width: number, paper: MovingPaper, t: number): number {
  const at = plan.stampAt ?? t;
  const moved = paper.shift ?? ((a: number, b: number) => ((b - a) / 1000) * paper.speed);
  const landX = (tau: number) => paper.penX - moved(tau, at);
  const s0 = plan.spike?.start ?? at;
  const s1 = plan.spike?.end ?? at;
  let x = (landX(s0) + landX(s1)) / 2 - width / 2;
  x = Math.min(x, paper.w - HOUSING - TILT_ROOM - width);
  x = Math.max(x, landX(plan.start) + TILT_ROOM);
  return x - moved(at, t);
}

/** Still paper (reduce motion): one sheet per question, so the stamp just stays on it. */
export function stampXOnSheet(plan: StampPlan, width: number, sheet: { w: number; left: number; xOf: (tau: number) => number }): number {
  const at = plan.stampAt ?? 0;
  const s0 = plan.spike?.start ?? at;
  const s1 = plan.spike?.end ?? at;
  const x = (sheet.xOf(s0) + sheet.xOf(s1)) / 2 - width / 2;
  return Math.max(sheet.left + TILT_ROOM, Math.min(x, sheet.w - HOUSING - TILT_ROOM - width));
}
