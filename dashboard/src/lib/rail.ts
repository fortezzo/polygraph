// The strip of questions above the chart paper. A short replay (the Highlights)
// shows every question. A whole interrogation (Session 10: 200 questions) shows
// one trap type at a time, with the 8 types as tabs, so it fits on a phone.

import type { Timeline, TrapPlan } from "./timeline";
import { TRAP_TYPES } from "./report";

/** More questions than this, and the strip shows one trap type at a time. */
export const MANY = 12;

export interface TypeGroup {
  key: string;
  label: string;
  short: string;
  traps: TrapPlan[];
}

/** The questions by trap type, in PLAN.md's order. A type the run didn't test isn't there. */
export function typeGroups(tl: Timeline): TypeGroup[] {
  const known: { key: string; label: string; short: string }[] = [...TRAP_TYPES];
  for (const p of tl.traps) {
    if (!known.some((k) => k.key === p.result.type)) known.push({ key: p.result.type, label: p.result.type, short: p.result.type });
  }
  return known
    .map((k) => ({ ...k, traps: tl.traps.filter((p) => p.result.type === k.key) }))
    .filter((g) => g.traps.length > 0);
}

/** The largest group: the strip keeps room for it, so switching types never moves the page. */
export function widestGroup(groups: TypeGroup[]): number {
  return groups.reduce((n, g) => Math.max(n, g.traps.length), 0);
}
