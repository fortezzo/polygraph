// Which part of a long answer an evidence card shows: the paragraphs around the
// made-up words (or the start, if nothing was made up), within a character
// budget. "Show the whole answer" opens the rest.

import type { Block } from "./markdown";

export interface BlockRange {
  first: number;
  last: number;
  /** Paragraphs were left out before / after the range. */
  before: boolean;
  after: boolean;
}

const lengthOf = (b: Block) => b.lines.reduce((n, l) => n + l.reduce((m, r) => m + r.text.length, 0), 0);
const startOf = (b: Block) => b.lines.find((l) => l.length)?.[0]?.start ?? -1;
const endOf = (b: Block) => {
  const runs = b.lines.flat();
  const last = runs[runs.length - 1];
  return last ? last.start + last.text.length : -1;
};

export function excerptRange(blocks: Block[], hot: { start: number; end: number } | null, budget = 650): BlockRange {
  if (!blocks.length) return { first: 0, last: -1, before: false, after: false };
  let center = 0;
  if (hot) {
    const i = blocks.findIndex((b) => hot.start >= startOf(b) && hot.start < endOf(b));
    // The phrase may start on a Markdown marker between blocks: take the next block.
    center = i >= 0 ? i : Math.max(0, blocks.findIndex((b) => startOf(b) >= hot.start));
  }
  let first = center;
  let last = center;
  let used = lengthOf(blocks[center]!);
  // Grow around the center, the smaller neighbor first, while it fits the budget.
  for (;;) {
    const next = last + 1 < blocks.length ? lengthOf(blocks[last + 1]!) : Infinity;
    const prev = first > 0 ? lengthOf(blocks[first - 1]!) : Infinity;
    const sides: ("next" | "prev")[] = next <= prev ? ["next", "prev"] : ["prev", "next"];
    const side = sides.find((s) => {
      const size = s === "next" ? next : prev;
      return size !== Infinity && used + size <= budget;
    });
    if (!side) break;
    if (side === "next") {
      last += 1;
      used += next;
    } else {
      first -= 1;
      used += prev;
    }
  }
  return { first, last, before: first > 0, after: last < blocks.length - 1 };
}
