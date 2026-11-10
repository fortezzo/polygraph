// A live run as a replay script (Session 8). The interrogation screen's parts
// (the chart paper, the transcript and the case folder) read a Timeline, so a
// live run is turned into one, with each piece at the time it showed up on
// screen. The needle spikes when the verdict arrives: live, the judge rules
// after the answer, so that's the moment it found the made-up words. The
// stamp lands on that spike, and the made-up words light up in the answer then.

import type { Conversation, TrapResult, Turn } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import type { LiveState, LiveTrap, LiveTurn } from "./live";
import { namesToHide } from "./names";
import { phraseIn } from "./phrase";
import type { Track } from "./signal";
import { headlineFor, typeChunks, type Timeline, type Tone, type TrapPlan, type TurnPlan, type Window } from "./timeline";

const SPIKE = 1200;
const STAMP_DELAY = 180;
const FINAL_DELAY = 600;
const FAR = Number.POSITIVE_INFINITY;
// Reduce motion draws each question on a still sheet, which needs an end:
// at least this long, and a little past the newest thing on it.
const SHEET = 30000;
const SHEET_ROOM = 15000;

/** The run file shape the case folder reads, from what's arrived so far. */
export function liveResult(trap: LiveTrap): TrapResult {
  const chats: Conversation[] = Array.from({ length: Math.max(1, trap.chats) }, () => ({ wording: null, turns: [] }));
  for (const turn of trap.turns) {
    const chat = chats[turn.chat] ?? (chats[turn.chat] = { wording: null, turns: [] });
    if (turn.wording !== null) chat.wording = turn.wording;
    const row: Turn = {
      role: turn.role,
      kind: turn.kind,
      content: turn.text,
      call: turn.role === "assistant" ? {} : null,
      confidence: turn.confidence ? { value: turn.confidence.value, reply: turn.confidence.reply } : null,
    };
    chat.turns.push(row);
  }
  const v = trap.verdict;
  return {
    id: trap.id,
    type: trap.type,
    label: trap.label,
    status: trap.answered?.status,
    trap: {
      id: trap.id,
      type: trap.type,
      question: trap.question,
      truth: v?.truth ?? "",
      source: { title: v?.source?.title ?? "", url: v?.source?.url ?? null },
      document: trap.document?.id,
    },
    conversations: chats.filter((c) => c.turns.length > 0),
    verdict: v?.verdict ?? null,
    made_up_phrase: v?.made_up_phrase ?? null,
    reason: v?.reason ?? v?.error ?? null,
    judgement: v
      ? {
          decided_by: v.decided_by ?? undefined,
          phrase_answer: v.phrase_answer,
          own_knowledge: v.own_knowledge,
          unsettled: v.unsettled,
          votes: v.votes.map((verdict) => ({ verdict })),
        }
      : null,
  };
}

function turnPlan(trap: LiveTrap, turn: LiveTurn, i: number, answerNo: number | null, chats: number): TurnPlan {
  const base = {
    key: `${trap.id}-${turn.chat}-${i}`,
    role: turn.role,
    kind: turn.kind,
    chat: turn.chat + 1,
    chats,
    answerNo,
    text: turn.text,
    hot: null,
    hidden: [],
  };
  if (turn.role === "user") {
    return {
      ...base,
      start: turn.at,
      end: turn.at + turn.typing,
      chunks: typeChunks(turn.text, turn.at, turn.typing),
      confidence: null,
    };
  }
  const chunks = turn.pieces.length ? turn.pieces : [{ at: turn.at, upto: 0 }];
  return {
    ...base,
    start: turn.pieces[0]?.at ?? turn.at,
    end: turn.done ? (turn.doneAt ?? turn.at) : FAR,
    chunks,
    // The confidence line's place is held from the start (unseen until the
    // reply comes), as in the replay, so nothing moves when it arrives.
    confidence: turn.confidence
      ? { at: turn.confidence.at, value: turn.confidence.value, reply: turn.confidence.reply }
      : { at: FAR, value: null, reply: null },
    saved: turn.saved,
  };
}

function trapPlan(trap: LiveTrap, next: LiveTrap | undefined, reduced: boolean): TrapPlan {
  const result = liveResult(trap);
  const v = trap.verdict;
  const verdict = v?.verdict ?? null;
  const caught = verdict ? VERDICT_INFO[verdict].caught : false;
  const tone = caught && verdict ? (verdict.toLowerCase() as Tone) : null;

  let answerNo = 0;
  const turns = trap.turns.map((turn, i) => {
    if (turn.role === "assistant") answerNo += 1;
    return turnPlan(trap, turn, i, turn.role === "assistant" ? answerNo : null, Math.max(1, trap.chats));
  });

  // The made-up words, once the verdict is in.
  const answers = trap.turns.filter((t) => t.role === "assistant").map((t) => ({ content: t.text }));
  const phrase = tone ? phraseIn(answers, v?.made_up_phrase, v?.phrase_answer) : null;
  if (phrase && tone) {
    const turn = turns.find((t) => t.answerNo === phrase.answer);
    if (turn) turn.hot = { start: phrase.start, end: phrase.end, tone };
  }
  // Christian's rule: in an answer Polygraph caught, names credited with a study
  // or citation are hidden on screen. Live, the verdict only comes after the
  // answer, so they're hidden while it streams in, before anyone knows whether
  // it's caught, and they stay hidden. (A replay knows the verdict, so it only
  // hides them in caught answers.)
  for (const turn of turns) if (turn.role === "assistant") turn.hidden = namesToHide(turn.text);

  const verdictAt = v ? v.at : FAR;
  const spike = tone && v ? { start: v.at, end: v.at + SPIKE, tone } : null;
  const quiet: Window[] = turns.filter((t) => t.role === "user").map((t) => ({ start: t.start, end: t.end + 300 }));
  const active: Window[] = turns.filter((t) => t.role === "assistant" && t.chunks.length > 1).map((t) => ({ start: t.start, end: t.end }));

  const latest = Math.max(trap.at, ...trap.turns.map((t) => t.doneAt ?? t.pieces[t.pieces.length - 1]?.at ?? t.at), v?.at ?? 0);
  const end = next ? next.at : reduced ? trap.at + Math.max(SHEET, latest - trap.at + SHEET_ROOM) : FAR;

  return {
    index: trap.index,
    id: trap.id,
    label: trap.label,
    verdict,
    tone,
    start: trap.at,
    end,
    exhibit: trap.document ? { title: trap.document.title, text: trap.document.text, at: trap.at } : null,
    turns,
    spike,
    stampAt: tone && v ? v.at + STAMP_DELAY : null,
    verdictAt,
    finalAt: v ? v.at + FINAL_DELAY : FAR,
    headline: headlineFor(result, phrase?.answer ?? null),
    quiet,
    active,
    result,
  };
}

/** The live run so far, as a Timeline the interrogation screen's parts can read. */
export function liveTimeline(state: LiveState, reduced: boolean): Timeline {
  const traps = state.traps.map((trap, i) => trapPlan(trap, state.traps[i + 1], reduced));
  return { traps, duration: state.finished ? state.finished.at + 1500 : FAR, reduced };
}

export function liveTrack(tl: Timeline): Track {
  return {
    quiet: tl.traps.flatMap((p) => p.quiet),
    active: tl.traps.flatMap((p) => p.active),
    spikes: tl.traps.flatMap((p) => (p.spike ? [p.spike] : [])),
  };
}

/**
 * The live screen's clock: it runs from when the screen opened, and stops when
 * the run is over. It has the replay clock's shape, so the chart paper can read it.
 */
export class LiveClock {
  private origin: number;
  private stopAt: number | null = null;

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.origin = this.clock();
  }

  private real(): number {
    return this.clock() - this.origin;
  }

  now(): number {
    const t = this.real();
    return this.stopAt === null ? t : Math.min(t, this.stopAt);
  }

  get status(): "playing" | "ended" {
    return this.stopAt !== null && this.real() >= this.stopAt ? "ended" : "playing";
  }

  /** Stop the clock (and the paper) when it reaches `t`, which can still be ahead. */
  stop(t: number): void {
    if (this.stopAt === null) this.stopAt = Math.max(0, t);
  }
}
