// Just enough Markdown for chatbot answers: paragraphs, line breaks, bullet and
// numbered lists, headings, code blocks, **bold**, *italics* and `code`.
//
// Every visible character keeps its position in the original text ("raw
// offset"). That's what lets the screen reveal an answer as it streams in and
// highlight the judge's made-up phrase, which is quoted from the raw text.

export type Mark = "b" | "i" | "code" | "link";

/** Visible characters in a row with the same marks. Character k is at raw offset start + k. */
export interface Run {
  text: string;
  start: number;
  marks: Mark[];
}

export type Line = Run[];

export type Block =
  | { kind: "p"; lines: Line[] }
  | { kind: "h"; lines: Line[] }
  | { kind: "li"; lines: Line[]; bullet: string; level: number }
  | { kind: "pre"; lines: Line[] };

interface Rule {
  re: RegExp;
  mark: Mark;
  open: number;
}

// Earliest match wins. On a tie, the first rule wins (code, then bold, then italics).
const RULES: Rule[] = [
  { re: /`([^`\n]+)`/, mark: "code", open: 1 },
  // [text](address): shown as its text. Never a clickable link: a bot's links are
  // its claims, not places to send people.
  { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/, mark: "link", open: 1 },
  { re: /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/, mark: "b", open: 2 },
  { re: /__(?=\S)([\s\S]+?)(?<=\S)__/, mark: "b", open: 2 },
  { re: /\*(?=[^\s*])([\s\S]+?)(?<=[^\s*])\*/, mark: "i", open: 1 },
  { re: /(?<![\p{L}\p{N}])_(?=\S)([\s\S]+?)(?<=\S)_(?![\p{L}\p{N}])/u, mark: "i", open: 1 },
];

export function parseInline(text: string, base: number, marks: Mark[] = []): Run[] {
  let best: { rule: Rule; m: RegExpExecArray } | null = null;
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m && (best === null || m.index < best.m.index)) best = { rule, m };
  }
  if (!best) return text ? [{ text, start: base, marks }] : [];
  const { rule, m } = best;
  const inner = m[1] ?? "";
  const innerStart = base + m.index + rule.open;
  const afterStart = m.index + m[0].length;
  const out: Run[] = [];
  if (m.index > 0) out.push({ text: text.slice(0, m.index), start: base, marks });
  if (rule.mark === "code") out.push({ text: inner, start: innerStart, marks: [...marks, "code"] });
  else out.push(...parseInline(inner, innerStart, [...marks, rule.mark]));
  out.push(...parseInline(text.slice(afterStart), base + afterStart, marks));
  return out;
}

const LIST_ITEM = /^(\s*)([*+-]|\d{1,3}[.)])(\s+)(.*)$/;
const HEADING = /^(#{1,6})(\s+)(.*)$/;
const FENCE = /^\s*```/;

export function parseAnswer(raw: string): Block[] {
  const blocks: Block[] = [];
  let para: Block | null = null;
  let fence: Block | null = null;
  let pos = 0;
  for (const text of raw.split("\n")) {
    const start = pos;
    pos += text.length + 1;
    if (FENCE.test(text)) {
      if (fence) fence = null;
      else {
        fence = { kind: "pre", lines: [] };
        blocks.push(fence);
      }
      para = null;
      continue;
    }
    if (fence) {
      fence.lines.push(text ? [{ text, start, marks: ["code"] }] : []);
      continue;
    }
    if (!text.trim()) {
      para = null;
      continue;
    }
    const li = LIST_ITEM.exec(text);
    if (li) {
      const [, indent = "", bullet = "", gap = "", body = ""] = li;
      const level = Math.min(Math.floor(indent.replace(/\t/g, "    ").length / 3), 3);
      blocks.push({
        kind: "li",
        bullet: /\d/.test(bullet) ? bullet : "•",
        level,
        lines: [parseInline(body, start + indent.length + bullet.length + gap.length)],
      });
      para = null;
      continue;
    }
    const h = HEADING.exec(text);
    if (h) {
      const [, hashes = "", gap = "", body = ""] = h;
      blocks.push({ kind: "h", lines: [parseInline(body, start + hashes.length + gap.length)] });
      para = null;
      continue;
    }
    if (!para) {
      para = { kind: "p", lines: [] };
      blocks.push(para);
    }
    para.lines.push(parseInline(text, start));
  }
  return blocks;
}

/** A piece of a run, split where the reveal point and the highlight start and end. */
export interface Piece {
  text: string;
  marks: Mark[];
  /** Already streamed in. Unshown text keeps its space, so nothing moves as it appears. */
  shown: boolean;
  /** Inside the judge's made-up phrase. */
  hot: boolean;
  /** Inside a hidden name: the start of that name, or null. See names.ts. */
  hidden: number | null;
  /** Raw offset of the first character. */
  start: number;
}

/**
 * Splits a line into pieces at word boundaries, the reveal point and the
 * highlight. Words are separate pieces, so text that hasn't streamed in yet
 * never moves: only the tail of the word being typed changes.
 */
export function piecesOf(
  line: Line,
  reveal: number,
  hot: { start: number; end: number } | null,
  hidden: readonly { start: number; end: number }[] = [],
): Piece[] {
  const out: Piece[] = [];
  for (const run of line) {
    const cuts = new Set<number>([0, run.text.length]);
    for (const m of run.text.matchAll(/\s+/g)) cuts.add(m.index! + m[0].length);
    for (const at of [reveal, hot?.start, hot?.end, ...hidden.flatMap((h) => [h.start, h.end])]) {
      if (at === undefined) continue;
      const k = at - run.start;
      if (k > 0 && k < run.text.length) cuts.add(k);
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (a === b) continue;
      const rawA = run.start + a;
      out.push({
        text: run.text.slice(a, b),
        marks: run.marks,
        start: rawA,
        shown: rawA < reveal,
        hot: hot !== null && rawA >= hot.start && rawA < hot.end,
        hidden: hidden.find((h) => rawA >= h.start && rawA < h.end)?.start ?? null,
      });
    }
  }
  return out;
}

/**
 * The raw offset of the last character of `span` that's actually visible. The
 * "MADE UP" tag goes right after the piece holding it. (The judge's quote can
 * end on invisible Markdown, like the address part of a link.)
 */
export function lastVisibleIn(blocks: Block[], span: { start: number; end: number } | null): number | null {
  if (!span) return null;
  let last: number | null = null;
  for (const b of blocks)
    for (const l of b.lines)
      for (const r of l) {
        const lo = Math.max(r.start, span.start);
        const hi = Math.min(r.start + r.text.length, span.end);
        if (hi > lo) last = Math.max(last ?? -1, hi - 1);
      }
  return last;
}

/** The visible text, without Markdown markers. For tests and screen readers. */
export function plainText(blocks: Block[]): string {
  return blocks.map((b) => b.lines.map((l) => l.map((r) => r.text).join("")).join("\n")).join("\n\n");
}
