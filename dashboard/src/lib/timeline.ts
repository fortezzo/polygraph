// The replay script. Given a run file, it works out when every question types
// itself out, when every answer streams in, when the needle spikes and when the
// stamp lands. All times are milliseconds from the start of the replay.
//
// The needle spike starts the moment the first letter of the judge's made-up
// phrase appears, and lasts while the phrase streams in. That's what "replayed
// in sync with the answer" means on screen.

import type { RunFile, TrapResult, Verdict } from "../data/runFile";
import { answersOf } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { phraseIn } from "./phrase";
import { namesToHide, type Span } from "./names";

export type Tone = "lie" | "caved" | "contradicted";

export interface Pace {
  leadIn: number;
  intro: number;
  exhibit: number;
  typeRate: number; // characters a second; 0 means the question appears at once
  typeMin: number;
  typeMax: number;
  think: number;
  streamRate: number;
  streamMin: number;
  streamMax: number;
  bySentence: boolean; // reduced motion: answers appear a sentence at a time
  confidenceDelay: number;
  confidenceShow: number;
  newChat: number;
  spikeMin: number;
  stampDelay: number;
  verdictDelay: number;
  finalDelay: number;
  hold: number;
  holdCaught: number;
}

export const NORMAL_PACE: Pace = {
  leadIn: 700, intro: 900, exhibit: 1400,
  typeRate: 45, typeMin: 500, typeMax: 3000, think: 550,
  streamRate: 110, streamMin: 800, streamMax: 8000, bySentence: false,
  confidenceDelay: 350, confidenceShow: 750, newChat: 600,
  spikeMin: 1200, stampDelay: 180, verdictDelay: 500, finalDelay: 600,
  hold: 3600, holdCaught: 4800,
};

export const REDUCED_PACE: Pace = {
  ...NORMAL_PACE,
  typeRate: 0, think: 1100, bySentence: true,
};

/** At time `at`, raw characters before `upto` are showing. */
export interface Chunk {
  at: number;
  upto: number;
}

export interface TurnPlan {
  key: string;
  role: "user" | "assistant";
  kind: string;
  chat: number;
  chats: number;
  /** For an answer, its number in the trap (1-based, across chats). */
  answerNo: number | null;
  text: string;
  start: number;
  end: number;
  chunks: Chunk[];
  confidence: { at: number; value: number | null; reply: string | null } | null;
  hot: { start: number; end: number; tone: Tone } | null;
  /** Names to show as "[name hidden]": people credited with a study or citation in a caught answer. */
  hidden: Span[];
  /** Live runs: a saved answer, reused from an earlier run, with the day the bot first gave it. */
  saved?: string | null;
}

export interface Headline {
  value: number;
  reply: string | null;
  /** How the number was picked, in words. */
  basis: string;
}

export interface TrapPlan {
  index: number;
  id: string;
  label: string;
  verdict: Verdict | null;
  tone: Tone | null;
  start: number;
  end: number;
  exhibit: { title: string; text: string; at: number } | null;
  turns: TurnPlan[];
  spike: { start: number; end: number; tone: Tone } | null;
  stampAt: number | null;
  verdictAt: number;
  finalAt: number;
  headline: Headline | null;
  quiet: Window[];
  active: Window[];
  result: TrapResult;
}

export interface Window {
  start: number;
  end: number;
}

export interface Timeline {
  traps: TrapPlan[];
  duration: number;
  reduced: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function typeChunks(text: string, start: number, dur: number): Chunk[] {
  if (dur <= 0 || text.length === 0) return [{ at: start, upto: text.length }];
  const out: Chunk[] = [];
  for (let i = 2; i < text.length; i += 2) out.push({ at: start + (dur * i) / text.length, upto: i });
  out.push({ at: start + dur, upto: text.length });
  return out;
}

/** Word-sized pieces, like the bits a chatbot streams. */
function streamChunks(text: string, start: number, dur: number, bySentence: boolean): Chunk[] {
  if (text.length === 0) return [{ at: start, upto: 0 }];
  const pieces = bySentence
    ? text.match(/[^.!?\n]*(?:[.!?]+|\n+|$)\s*/g)?.filter(Boolean) ?? [text]
    : text.match(/\s*\S{1,6}|\s+/g) ?? [text];
  // In reduced motion, at most 6 steps per answer.
  let groups = pieces;
  if (bySentence && pieces.length > 6) {
    const per = Math.ceil(pieces.length / 6);
    groups = [];
    for (let i = 0; i < pieces.length; i += per) groups.push(pieces.slice(i, i + per).join(""));
  }
  const out: Chunk[] = [];
  let upto = 0;
  for (const [i, g] of groups.entries()) {
    upto += g.length;
    // Reduced motion: the first sentence shows at once, then the rest step in.
    const frac = bySentence ? i / groups.length : upto / text.length;
    out.push({ at: start + dur * frac, upto });
  }
  out[out.length - 1]!.upto = text.length;
  return out;
}

/** When the character at raw offset `offset` has appeared. */
export function timeRevealed(chunks: Chunk[], offset: number): number {
  for (const c of chunks) if (c.upto > offset) return c.at;
  return chunks[chunks.length - 1]?.at ?? 0;
}

/** The headline confidence for the case notes, by the Session 4 calibration rule. */
export function headlineFor(trap: TrapResult, caughtAnswer: number | null): Headline | null {
  const answers = answersOf(trap);
  if (trap.type === "consistency" && answers.length > 1) {
    const values = answers.map((a) => a.confidence?.value).filter((v): v is number => typeof v === "number");
    if (values.length === 0) return null;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return { value: Math.round(avg), reply: null, basis: `the average of its ${values.length} answers (${values.join(", ")})` };
  }
  const n = caughtAnswer ?? answers.length;
  const c = answers[n - 1]?.confidence;
  if (!c || typeof c.value !== "number") return null;
  const which = answers.length > 1 ? `after answer ${n} of ${answers.length}` : "after its answer";
  return { value: c.value, reply: c.reply?.trim() ?? null, basis: which };
}

function planTrap(run: RunFile, trap: TrapResult, index: number, t0: number, pace: Pace): TrapPlan {
  let t = t0 + pace.intro;
  const verdict = trap.verdict;
  const caught = verdict ? VERDICT_INFO[verdict].caught : false;
  const tone = caught && verdict ? (verdict.toLowerCase() as Tone) : null;
  const answers = answersOf(trap);

  // Which answer holds the made-up phrase (phrase.ts).
  const phrase = tone ? phraseIn(answers, trap.made_up_phrase, trap.judgement?.phrase_answer) : null;

  const doc = trap.trap.document ? run.documents?.[trap.trap.document] : undefined;
  let exhibit: TrapPlan["exhibit"] = null;
  if (doc) {
    exhibit = { title: doc.title, text: doc.text, at: t };
    t += pace.exhibit;
  }

  const turns: TurnPlan[] = [];
  const quiet: Window[] = [];
  const active: Window[] = [];
  let spike: TrapPlan["spike"] = null;
  let stampAt: number | null = null;
  let answerNo = 0;
  const chats = trap.conversations.length;

  for (const [ci, conv] of trap.conversations.entries()) {
    if (ci > 0) t += pace.newChat;
    for (const [ti, turn] of conv.turns.entries()) {
      const key = `${trap.id}-${ci}-${ti}`;
      if (turn.role === "user") {
        // A document trap's message also holds the document. The exhibit shows that,
        // so the typed line is just the question.
        const text = doc && turn.kind === "question" ? trap.trap.question : turn.content;
        const dur = pace.typeRate > 0 ? clamp((text.length / pace.typeRate) * 1000, pace.typeMin, pace.typeMax) : 0;
        quiet.push({ start: t, end: t + dur + pace.think });
        turns.push({
          key, role: "user", kind: turn.kind, chat: ci + 1, chats, answerNo: null, text,
          start: t, end: t + dur, chunks: typeChunks(text, t, dur), confidence: null, hot: null, hidden: [],
        });
        t += dur + pace.think;
      } else {
        answerNo += 1;
        const text = turn.content;
        const dur = clamp((text.length / pace.streamRate) * 1000, pace.streamMin, pace.streamMax);
        const chunks = streamChunks(text, t, dur, pace.bySentence);
        let hot: TurnPlan["hot"] = null;
        if (phrase && tone && phrase.answer === answerNo) {
          hot = { start: phrase.start, end: phrase.end, tone };
          const s = timeRevealed(chunks, phrase.start);
          const e = timeRevealed(chunks, phrase.end - 1);
          spike = { start: s, end: Math.max(e, s + pace.spikeMin), tone };
          stampAt = Math.max(e, s) + pace.stampDelay;
        }
        active.push({ start: t, end: t + dur });
        const end = t + dur;
        const c = turn.confidence;
        const confAt = end + pace.confidenceDelay;
        turns.push({
          key, role: "assistant", kind: turn.kind, chat: ci + 1, chats, answerNo, text,
          start: t, end, chunks,
          confidence: c ? { at: confAt, value: c.value, reply: c.reply } : null,
          hot,
          // Christian's rule: in an answer Polygraph caught, names credited with a study
          // or citation are hidden on screen. The run file keeps them.
          hidden: tone ? namesToHide(text) : [],
        });
        t = c ? confAt + pace.confidenceShow : end;
      }
    }
  }

  // A caught trap whose phrase couldn't be placed still gets its stamp, at the end.
  if (tone && stampAt === null) stampAt = t + pace.stampDelay;
  const verdictAt = tone && stampAt !== null ? stampAt : t + pace.verdictDelay;
  const finalAt = Math.max(t, verdictAt) + pace.finalDelay;
  const end = finalAt + (tone ? pace.holdCaught : pace.hold);

  return {
    index, id: trap.id, label: trap.label, verdict, tone,
    start: t0, end, exhibit, turns, spike, stampAt, verdictAt, finalAt,
    headline: headlineFor(trap, phrase?.answer ?? null),
    quiet, active, result: trap,
  };
}

export function buildTimeline(run: RunFile, opts: { reduced?: boolean } = {}): Timeline {
  const pace = opts.reduced ? REDUCED_PACE : NORMAL_PACE;
  let t = pace.leadIn;
  const traps = run.traps.map((trap, i) => {
    const plan = planTrap(run, trap, i, t, pace);
    t = plan.end;
    return plan;
  });
  return { traps, duration: t, reduced: !!opts.reduced };
}

// ---- What the screen shows at a moment ------------------------------------

export interface TurnView {
  started: boolean;
  reveal: number;
  typing: boolean;
  confidenceShown: boolean;
}

export interface View {
  trap: number;
  turns: TurnView[];
  exhibitShown: boolean;
  spiking: boolean;
  stamped: boolean;
  verdictShown: boolean;
  finalShown: boolean;
  ended: boolean;
  /** For the progress rail: the verdict of every trap that has one showing. */
  shown: (Verdict | null | undefined)[];
}

function revealAt(chunks: Chunk[], t: number): number {
  let lo = 0;
  let hi = chunks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid]!.at <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? chunks[found]!.upto : 0;
}

export function trapIndexAt(tl: Timeline, t: number): number {
  if (tl.traps.length === 0) return -1;
  for (let i = tl.traps.length - 1; i >= 0; i--) if (t >= tl.traps[i]!.start) return i;
  return 0;
}

export function viewAt(tl: Timeline, t: number): View {
  const ended = t >= tl.duration;
  const i = trapIndexAt(tl, t);
  const plan = tl.traps[i];
  const shown = tl.traps.map((p) => (t >= p.verdictAt ? p.verdict : undefined));
  if (!plan) {
    return { trap: -1, turns: [], exhibitShown: false, spiking: false, stamped: false, verdictShown: false, finalShown: false, ended, shown };
  }
  return {
    trap: i,
    turns: plan.turns.map((tp) => ({
      started: t >= tp.start,
      reveal: t < tp.start ? 0 : revealAt(tp.chunks, t),
      typing: t >= tp.start && t < tp.end,
      confidenceShown: tp.confidence !== null && t >= tp.confidence.at,
    })),
    exhibitShown: plan.exhibit !== null && t >= plan.exhibit.at,
    spiking: plan.spike !== null && t >= plan.spike.start && t < plan.spike.end,
    stamped: plan.stampAt !== null && t >= plan.stampAt,
    verdictShown: t >= plan.verdictAt,
    finalShown: t >= plan.finalAt,
    ended,
    shown,
  };
}

/** A short fingerprint of a view, so the screen only redraws when something changed. */
export function viewKey(v: View): string {
  const turns = v.turns.map((x) => `${x.started ? "s" : ""}${x.reveal}${x.typing ? "t" : ""}${x.confidenceShown ? "c" : ""}`).join(",");
  const flags = [v.exhibitShown, v.spiking, v.stamped, v.verdictShown, v.finalShown, v.ended].map((f) => (f ? 1 : 0)).join("");
  return `${v.trap}|${turns}|${flags}|${v.shown.map((s) => s ?? "-").join(",")}`;
}

/** Named moments, for jumping around and for the screenshot script. */
export interface Mark {
  trap: string;
  name: "start" | "question" | "answer" | "spike" | "stamp" | "verdict" | "final" | "end";
  t: number;
}

export function marksOf(tl: Timeline): Mark[] {
  const marks: Mark[] = [];
  for (const p of tl.traps) {
    marks.push({ trap: p.id, name: "start", t: p.start });
    const q = p.turns.find((x) => x.role === "user");
    const a = p.turns.find((x) => x.role === "assistant");
    if (q) marks.push({ trap: p.id, name: "question", t: q.start });
    if (a) marks.push({ trap: p.id, name: "answer", t: a.start });
    if (p.spike) marks.push({ trap: p.id, name: "spike", t: p.spike.start });
    if (p.stampAt !== null) marks.push({ trap: p.id, name: "stamp", t: p.stampAt });
    marks.push({ trap: p.id, name: "verdict", t: p.verdictAt });
    marks.push({ trap: p.id, name: "final", t: p.finalAt });
    marks.push({ trap: p.id, name: "end", t: p.end });
  }
  return marks;
}
