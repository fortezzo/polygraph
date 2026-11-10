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

/** Moving paper: the pen stays at penX and the paper moves left at `speed` pixels a second. */
export interface MovingPaper {
  w: number;
  penX: number;
  speed: number;
}

/** The stamp's left edge on moving paper at time t, in pixels. */
export function stampX(plan: StampPlan, width: number, paper: MovingPaper, t: number): number {
  const at = plan.stampAt ?? t;
  const landX = (tau: number) => paper.penX - ((at - tau) / 1000) * paper.speed;
  const s0 = plan.spike?.start ?? at;
  const s1 = plan.spike?.end ?? at;
  let x = (landX(s0) + landX(s1)) / 2 - width / 2;
  x = Math.min(x, paper.w - HOUSING - TILT_ROOM - width);
  x = Math.max(x, landX(plan.start) + TILT_ROOM);
  return x - ((t - at) / 1000) * paper.speed;
}

/** Still paper (reduce motion): one sheet per question, so the stamp just stays on it. */
export function stampXOnSheet(plan: StampPlan, width: number, sheet: { w: number; left: number; xOf: (tau: number) => number }): number {
  const at = plan.stampAt ?? 0;
  const s0 = plan.spike?.start ?? at;
  const s1 = plan.spike?.end ?? at;
  const x = (sheet.xOf(s0) + sheet.xOf(s1)) / 2 - width / 2;
  return Math.max(sheet.left + TILT_ROOM, Math.min(x, sheet.w - HOUSING - TILT_ROOM - width));
}
