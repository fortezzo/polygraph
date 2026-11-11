// A live run, as the dashboard sees it (Session 8). The server sends events
// (polygraph/live/run.py lists them all); this file turns them into what the
// live screen shows, and when.
//
// Times here are milliseconds on the screen's own clock. Each event gets a
// "show at" time: the moment it arrived, unless the screen is still showing
// something that has to finish first. After a verdict, the screen holds it a
// few seconds before the next question appears, so every verdict can be seen
// (the server has usually started the next question by then). Words that
// arrive while the screen is catching up play out a little faster than they
// came, until it's caught up.
//
// A saved answer (reused from an earlier run) is never streamed as if it were
// new: it appears whole, marked with the date the bot first gave it
// (Christian, Session 8).

import type { Verdict } from "../data/runFile";
import type { Problem } from "./api";
import { modelName } from "./models";

export interface LiveEvent {
  id: number;
  type: string;
  t: number;
  [key: string]: unknown;
}

export interface Pacing {
  typeRate: number; // characters a second for a question typing itself out; 0: at once
  typeMin: number;
  typeMax: number;
  afterQuestion: number;
  catchUp: number; // ms between pieces of an answer while the screen catches up
  holdCaught: number; // how long a caught verdict stays before the next question
  hold: number;
  // A caught verdict lands at least this long after its question started, so the
  // CAUGHT stamp has room on its own question's stretch of moving paper (stamp.ts).
  // Saved answers come back at once, so without it the stamp couldn't fit.
  caughtAfter: number;
}

export const LIVE_PACE: Pacing = { typeRate: 90, typeMin: 300, typeMax: 1500, afterQuestion: 150, catchUp: 30, holdCaught: 4200, hold: 2600, caughtAfter: 6000 };
// Reduce motion: each question gets its own still sheet, so the stamp always fits.
export const LIVE_REDUCED_PACE: Pacing = { ...LIVE_PACE, typeRate: 0, catchUp: 0, caughtAfter: 0 };

export interface LiveConfidence {
  at: number;
  value: number | null;
  reply: string | null;
  error: string | null;
  saved: boolean;
}

export interface LiveTurn {
  role: "user" | "assistant";
  kind: string;
  chat: number; // 0-based
  wording: number | null;
  text: string;
  at: number;
  /** A question: how long it takes to type itself out. */
  typing: number;
  /** An answer: its text as it arrived, piece by piece. */
  pieces: { at: number; upto: number }[];
  done: boolean;
  doneAt: number | null;
  /** A saved answer: the day the bot first gave it. */
  saved: string | null;
  truncated: boolean;
  confidence: LiveConfidence | null;
}

export interface LiveVerdict {
  at: number;
  verdict: Verdict | null;
  made_up_phrase: string | null;
  phrase_answer: number | null;
  reason: string | null;
  decided_by: string | null;
  votes: (Verdict | null)[];
  own_knowledge: boolean;
  unsettled: boolean;
  error: string | null;
  saved: string | null;
  truth: string | null;
  source: { title: string | null; url: string | null } | null;
  hard_check: { kind?: string; outcome?: string; summary?: string } | null;
}

export interface LiveTrap {
  id: string;
  index: number;
  type: string;
  label: string;
  question: string;
  chats: number;
  document: { id: string; title: string; text: string } | null;
  at: number;
  turns: LiveTurn[];
  answered: { at: number; status: string; error: string | null } | null;
  judging: { at: number; step: string } | null;
  verdict: LiveVerdict | null;
}

export interface LiveInfo {
  run: string;
  bot: { provider: string; provider_label: string; model: string; maker: string; local: boolean; name: string | null; instructions: string | null };
  judge: { provider: string; provider_label: string; model: string; maker: string; votes: number };
  traps: { trap: string; index: number; trap_type: string; label: string }[];
  fresh: boolean;
  limit_usd: number;
  estimated_usd: number;
  confidence_question?: string;
  pretend: boolean;
}

export interface LiveFinished {
  at: number;
  status: string;
  stop_reason: string | null;
  run_id: string | null;
  run_file: string | null;
  judged_file: string | null;
  exported: boolean;
  spent_usd: number;
  duration_seconds: number | null;
  pretend: boolean;
  scores: {
    overall: number | null;
    grade: string | null;
    margin_of_error: number | null;
    interval: [number, number] | null;
    verdicts: Partial<Record<Verdict, number>>;
    by_type: Record<string, number | null>;
    judged: number;
    traps: number;
  } | null;
  judge_status: string | null;
  judge_stop_reason: string | null;
}

export interface LiveState {
  info: LiveInfo | null;
  startedAt: number | null;
  traps: LiveTrap[];
  spent: number;
  lastId: number;
  retrying: { at: number; until: number; who: string; message: string; attempt: number; of: number } | null;
  errors: (Problem & { at: number })[];
  stopping: boolean;
  finished: LiveFinished | null;
  /** Nothing new shows before this time. */
  cursor: number;
}

export const EMPTY_LIVE: LiveState = {
  info: null,
  startedAt: null,
  traps: [],
  spent: 0,
  lastId: 0,
  retrying: null,
  errors: [],
  stopping: false,
  finished: null,
  cursor: 0,
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-09T15:51:02-06:00" -> "Nov 9", the day as it was where the answer was recorded. */
export function dayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

function updateTrap(state: LiveState, id: unknown, change: (t: LiveTrap) => LiveTrap): LiveState {
  const i = state.traps.findIndex((t) => t.id === id);
  if (i < 0) return state;
  const traps = state.traps.slice();
  traps[i] = change(traps[i]!);
  return { ...state, traps };
}

function updateTurn(trap: LiveTrap, chat: number, role: LiveTurn["role"], change: (turn: LiveTurn) => LiveTurn): LiveTrap {
  for (let i = trap.turns.length - 1; i >= 0; i--) {
    const turn = trap.turns[i]!;
    if (turn.chat === chat && turn.role === role) {
      const turns = trap.turns.slice();
      turns[i] = change(turn);
      return { ...trap, turns };
    }
  }
  return trap;
}

/** The latest answer in a chat, or a new (empty) one if the last turn there is a question. */
function answerTurn(trap: LiveTrap, chat: number, at: number): LiveTrap {
  const last = [...trap.turns].reverse().find((t) => t.chat === chat);
  if (last && last.role === "assistant" && !last.done) return trap;
  const turn: LiveTurn = {
    role: "assistant", kind: "answer", chat, wording: last?.wording ?? null, text: "", at,
    typing: 0, pieces: [], done: false, doneAt: null, saved: null, truncated: false, confidence: null,
  };
  return { ...trap, turns: [...trap.turns, turn] };
}

/** One event applied to the state. `now` is when it arrived, on the screen's clock. */
export function applyEvent(state: LiveState, e: LiveEvent, now: number, pace: Pacing = LIVE_PACE): LiveState {
  if (e.id <= state.lastId) return state; // already seen (a reconnect can repeat some)
  let s: LiveState = { ...state, lastId: e.id };
  const behind = s.cursor > now;
  const at = Math.max(now, s.cursor);
  const spent = num(e.spent_usd);
  if (spent !== null) s.spent = spent;

  switch (e.type) {
    case "run_started": {
      s.info = e as unknown as LiveInfo;
      s.startedAt = now;
      s.cursor = at;
      return s;
    }
    case "trap_started": {
      const doc = e.document as LiveTrap["document"];
      const trap: LiveTrap = {
        id: String(e.trap), index: num(e.index) ?? s.traps.length, type: String(e.trap_type), label: String(e.label),
        question: String(e.question ?? ""), chats: num(e.chats) ?? 1, document: doc ?? null, at,
        turns: [], answered: null, judging: null, verdict: null,
      };
      s.traps = [...s.traps, trap];
      s.cursor = at;
      s.retrying = null;
      return s;
    }
    case "question": {
      const text = String(e.text ?? "");
      const typing = pace.typeRate <= 0 ? 0 : clamp((text.length / pace.typeRate) * 1000, pace.typeMin, pace.typeMax);
      const turn: LiveTurn = {
        role: "user", kind: String(e.kind ?? "question"), chat: num(e.chat) ?? 0, wording: num(e.wording), text, at,
        typing, pieces: [], done: true, doneAt: at + typing, saved: null, truncated: false, confidence: null,
      };
      s = updateTrap(s, e.trap, (t) => ({ ...t, turns: [...t.turns, turn] }));
      s.cursor = at + typing + pace.afterQuestion;
      return s;
    }
    case "answer_chunk": {
      const chat = num(e.chat) ?? 0;
      const piece = String(e.text ?? "");
      const showAt = behind && pace.catchUp > 0 ? s.cursor + pace.catchUp : at;
      s = updateTrap(s, e.trap, (t) =>
        updateTurn(answerTurn(t, chat, showAt), chat, "assistant", (turn) => {
          const text = turn.text + piece;
          return { ...turn, text, pieces: [...turn.pieces, { at: showAt, upto: text.length }] };
        }),
      );
      s.cursor = showAt;
      return s;
    }
    case "answer_restart": {
      const chat = num(e.chat) ?? 0;
      s = updateTrap(s, e.trap, (t) => updateTurn(t, chat, "assistant", (turn) => (turn.done ? turn : { ...turn, text: "", pieces: [] })));
      return s;
    }
    case "answer": {
      const chat = num(e.chat) ?? 0;
      const final = String(e.text ?? "");
      const saved = e.from_cache === true ? dayOf(str(e.first_collected_at)) ?? "an earlier run" : null;
      s = updateTrap(s, e.trap, (t) =>
        updateTurn(answerTurn(t, chat, at), chat, "assistant", (turn) => {
          // A saved answer appears whole. A streamed one keeps its pieces; if the
          // finished text differs (private thinking taken out), it's swapped in.
          const pieces = saved !== null || !final.startsWith(turn.text) || turn.pieces.length === 0
            ? [{ at, upto: final.length }]
            : [...turn.pieces, { at, upto: final.length }];
          return { ...turn, text: final, pieces, done: true, doneAt: at, saved, truncated: e.truncated === true };
        }),
      );
      s.cursor = at;
      return s;
    }
    case "confidence": {
      const chat = num(e.chat) ?? 0;
      const confidence: LiveConfidence = {
        at, value: num(e.value), reply: str(e.reply), error: str(e.error), saved: e.from_cache === true,
      };
      s = updateTrap(s, e.trap, (t) => updateTurn(t, chat, "assistant", (turn) => ({ ...turn, confidence })));
      s.cursor = at;
      return s;
    }
    case "trap_answered": {
      s = updateTrap(s, e.trap, (t) => ({ ...t, answered: { at, status: String(e.status ?? "done"), error: str(e.error) } }));
      return s;
    }
    case "judging": {
      s = updateTrap(s, e.trap, (t) => ({ ...t, judging: { at, step: String(e.step ?? "The judge is reading it") } }));
      return s;
    }
    case "verdict": {
      const kind = str(e.verdict);
      const caught = kind === "LIE" || kind === "CAVED" || kind === "CONTRADICTED";
      const started = s.traps.find((t) => t.id === e.trap)?.at ?? at;
      const verdictAt = caught ? Math.max(at, started + pace.caughtAfter) : at;
      const verdict: LiveVerdict = {
        at: verdictAt,
        verdict: (str(e.verdict) as Verdict | null) ?? null,
        made_up_phrase: str(e.made_up_phrase),
        phrase_answer: num(e.phrase_answer),
        reason: str(e.reason),
        decided_by: str(e.decided_by),
        votes: Array.isArray(e.votes) ? (e.votes as (Verdict | null)[]) : [],
        own_knowledge: e.own_knowledge === true,
        unsettled: e.unsettled === true,
        error: str(e.error),
        saved: e.from_cache === true ? dayOf(str(e.first_collected_at)) ?? "an earlier run" : null,
        truth: str(e.truth),
        source: (e.source as LiveVerdict["source"]) ?? null,
        hard_check: (e.hard_check as LiveVerdict["hard_check"]) ?? null,
      };
      // The judging status stays up until the verdict lands.
      s = updateTrap(s, e.trap, (t) => ({ ...t, verdict }));
      s.cursor = verdictAt + (caught ? pace.holdCaught : pace.hold);
      return s;
    }
    case "retrying": {
      const wait = (num(e.wait) ?? 0) * 1000;
      s.retrying = { at: now, until: now + wait, who: String(e.who ?? "bot"), message: String(e.message ?? ""), attempt: num(e.attempt) ?? 2, of: num(e.of) ?? 5 };
      return s;
    }
    case "error": {
      const problem = { title: String(e.title ?? "Something went wrong"), message: String(e.message ?? ""), hint: str(e.hint), kind: String(e.kind ?? "error"), at: now };
      s.errors = [...s.errors, problem];
      return s;
    }
    case "stopping":
      s.stopping = true;
      return s;
    case "run_finished": {
      s.finished = { ...(e as unknown as LiveFinished), at };
      s.retrying = null;
      return s;
    }
    default:
      return s;
  }
}

/**
 * Where the run is, in a few words, for the status line: about the trap on
 * screen (`shown`, its index) as it looks at time `now`. The screen can be a
 * little behind the server, so this follows the screen, not the latest event.
 */
export function statusLine(state: LiveState, now: number, shown?: number): string {
  if (state.finished && now >= state.finished.at) return "";
  if (state.stopping) return "Stopping. What's finished is being saved…";
  if (state.retrying && now < state.retrying.until) {
    const secs = Math.max(1, Math.ceil((state.retrying.until - now) / 1000));
    return `${state.retrying.message} Trying again in ${secs} second${secs === 1 ? "" : "s"} (try ${state.retrying.attempt} of ${state.retrying.of}).`;
  }
  const trap = shown !== undefined && shown >= 0 ? state.traps[shown] : state.traps[state.traps.length - 1];
  if (!state.info || !trap) return "Getting the interrogation ready…";
  const who = state.info.bot.name ?? modelName(state.info.bot.model);
  if (trap.verdict && trap.verdict.at <= now) return "";
  const turns = trap.turns.filter((t) => t.at <= now);
  const last = turns[turns.length - 1];
  // A saved answer says so (Christian, Session 8), here as well as on the answer.
  // Every message fits in two lines on a phone, so the line never changes height.
  const answer = [...turns].reverse().find((t) => t.role === "assistant" && t.done);
  const savedOn = answer?.saved ?? null;
  // A verdict that's in but not on screen yet: a saved one says so.
  const ready = trap.turns.length > 0 && trap.turns.every((t) => t.at <= now && (t.role === "user" || (t.done && (t.doneAt ?? 0) <= now)));
  const verdictOn = trap.verdict?.saved ?? null;
  if (verdictOn && ready) {
    if (savedOn === verdictOn) return `Reused the saved answer and verdict from ${savedOn}…`;
    return savedOn ? `Reused the saved answer from ${savedOn} and verdict from ${verdictOn}…` : `Using the judge's saved verdict from ${verdictOn}…`;
  }
  const saved = savedOn ? `Saved answer from ${savedOn}. ` : "";
  if (trap.judging && trap.judging.at <= now) return `${saved}${trap.judging.step}…`;
  if (!last || last.role === "user") return `Waiting for ${who} to answer…`;
  if (!last.done || (last.doneAt ?? 0) > now) return `${who} is answering…`;
  if (!last.confidence || last.confidence.at > now) return `${saved}Asking how sure it is…`;
  return savedOn ? `Saved answer from ${savedOn}, reused instead of asked again.` : "";
}

/** The same state, with every time on it moved by `delta` milliseconds. */
export function shiftTimes(s: LiveState, delta: number): LiveState {
  const by = (t: number) => t + delta;
  return {
    ...s,
    startedAt: s.startedAt === null ? null : by(s.startedAt),
    cursor: by(s.cursor),
    retrying: s.retrying && { ...s.retrying, at: by(s.retrying.at), until: by(s.retrying.until) },
    errors: s.errors.map((e) => ({ ...e, at: by(e.at) })),
    finished: s.finished && { ...s.finished, at: by(s.finished.at) },
    traps: s.traps.map((t) => ({
      ...t,
      at: by(t.at),
      answered: t.answered && { ...t.answered, at: by(t.answered.at) },
      judging: t.judging && { ...t.judging, at: by(t.judging.at) },
      verdict: t.verdict && { ...t.verdict, at: by(t.verdict.at) },
      turns: t.turns.map((u) => ({
        ...u,
        at: by(u.at),
        doneAt: u.doneAt === null ? null : by(u.doneAt),
        pieces: u.pieces.map((p) => ({ ...p, at: by(p.at) })),
        confidence: u.confidence && { ...u.confidence, at: by(u.confidence.at) },
      })),
    })),
  };
}

/**
 * Catching up after a reload: the events that happened before the page
 * opened, laid out at the screen's usual pace as if it had been watching, and
 * moved back so the last of them is now. The paper then shows a proper record.
 */
export function catchUp(events: LiveEvent[], now: number, pace: Pacing = LIVE_PACE): LiveState {
  const s = events.reduce((state, e) => applyEvent(state, e, 0, pace), EMPTY_LIVE);
  return shiftTimes(s, now - s.cursor);
}

/** The verdicts on screen at time `now`, by type. */
export function tally(state: LiveState, now: number = Number.POSITIVE_INFINITY): Partial<Record<Verdict, number>> {
  const out: Partial<Record<Verdict, number>> = {};
  for (const t of state.traps) {
    const v = t.verdict && t.verdict.at <= now ? t.verdict.verdict : null;
    if (v) out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}
