// The lineup screen's data (made by scripts/lineup.mjs, inside index.json) and
// the words it uses. Scores are the engine's own; nothing here recomputes them.

import type { Verdict } from "../data/runFile";
import { shownScore } from "./report";

export type LineupState = "scored" | "on_hold" | "not_judged" | "not_run";

export interface LineupScore {
  overall: number;
  grade: string;
  margin_of_error: number | null;
  interval: [number, number] | null;
}

export interface Thinking {
  /** The levels the provider reported on the bot's answers ("medium"…). */
  levels: string[];
  /** What Polygraph asked for: always "the model's default" in the lineup. */
  asked: string | null;
  /** Whether it thinks before answering; null when nobody knows. */
  thinks: boolean | null;
}

export interface PlacardJudge {
  model: string;
  company: string | null;
  /** Its agreement with Christian on his 50 test-half answers, if it was measured with the same setup. */
  measured: {
    agree: number;
    answers: number;
    percent: number;
    honest_called_caught: number;
    caught_called_honest: number;
    direction: "generous" | "harsh" | "even" | null;
  } | null;
}

export interface LineupBot {
  model: string;
  maker: string | null;
  provider: string | null;
  /** One of the bots whose judge is being chosen (Session 9). */
  waiting_for_judge: boolean;
  state: LineupState;
  size: string | null;
  /** The dashboard's run id: the report card and evidence wall open it. */
  run_id: string | null;
  started_at: string | null;
  traps: number | null;
  score: LineupScore | null;
  judge: PlacardJudge | null;
  /** On hold: the judge whose grades are on hold. */
  held_by: string | null;
  thinking: Thinking | null;
  cut_off: { answers: number; traps: string[] } | null;
}

export interface LeanCell {
  yours: Verdict;
  judge: Verdict | "NOT_JUDGED";
  count: number;
}

export interface Lean {
  direction: "generous" | "harsh" | "even";
  generous_total: number;
  harsh_total: number;
  sideways_total: number;
  generous: LeanCell[];
  harsh: LeanCell[];
  sideways: LeanCell[];
}

export interface LineupJudge {
  judge: string;
  company: string | null;
  /** Lineup bots it scores now. */
  grades: string[];
  /** Lineup bots it graded, with those grades on hold. */
  held_bots: string[];
  measured: {
    answers: number;
    agree: number;
    percent: number;
    percent_range: [number, number] | null;
    kappa: number | null;
    honest_vs_caught: number | null;
    score_of_the_50: { labels: number | null; judge: number | null };
    lean: Lean;
    measured_at: string | null;
    file: string;
    settings: { thinking: string | null } | null;
  } | null;
  /** The line Christian set in advance, for a judge measured against one. */
  line: { agree: number | null; answers: number | null; percent: number | null; passed: boolean } | null;
  decision: { decision: string | null; why: string[]; file: string | null } | null;
  hold: { since: string | null; why: string | null } | null;
  versus: { other: string; agree: number | null; answers: number | null; percent: number | null } | null;
}

export interface PairSide {
  model: string | null;
  name: string | null;
  custom: boolean;
  maker: string | null;
  state: LineupState;
  run_id: string | null;
  score: LineupScore | null;
  by_type: Record<string, { score: number; interval: [number, number] | null; traps: number | null } | null>;
  judge: string | null;
  instructions: string | null;
}

export interface DiffRow {
  trap: string;
  type: string;
  question: string;
  left: Verdict | null;
  right: Verdict | null;
}

export interface LineupPair {
  id: string;
  kind: "custom" | "models";
  why: string | null;
  left: PairSide;
  right: PairSide;
  same_judge: boolean;
  differ: { compared: number; rows: DiffRow[]; only_left_caught: number; only_right_caught: number } | null;
}

export interface LineupData {
  trap_set: string;
  traps: number | null;
  hold: { judges: string[]; bots: string[]; since: string | null; headline: string | null; why: string | null } | null;
  bots: LineupBot[];
  judges: LineupJudge[];
  pairs: LineupPair[];
}

const STATE_ORDER: Record<LineupState, number> = { scored: 0, on_hold: 1, not_judged: 2, not_run: 3 };

/** The wall's order: scored bots by Truth Score (highest first), then the rest, each in the roster's order. */
export function wallOrder(bots: LineupBot[]): LineupBot[] {
  return bots
    .map((b, i) => ({ b, i }))
    .sort((x, y) => {
      const s = STATE_ORDER[x.b.state] - STATE_ORDER[y.b.state];
      if (s) return s;
      if (x.b.state === "scored" && y.b.state === "scored") {
        const d = (y.b.score?.overall ?? 0) - (x.b.score?.overall ?? 0);
        if (d) return d;
      }
      return x.i - y.i;
    })
    .map(({ b }) => b);
}

/** Each scored bot's place: 1 for the highest Truth Score. Bots with the same shown score share a place. */
export function ranks(bots: LineupBot[]): Map<string, number> {
  const scored = wallOrder(bots).filter((b) => b.state === "scored");
  const out = new Map<string, number>();
  scored.forEach((b, i) => {
    const prev = scored[i - 1];
    const same = prev && shownScore(prev.score?.overall) === shownScore(b.score?.overall);
    out.set(b.model, same ? out.get(prev!.model)! : i + 1);
  });
  return out;
}

/** Scored bots whose 95% ranges overlap a neighbor's: their places could swap. */
export function overlapping(bots: LineupBot[]): boolean {
  const scored = wallOrder(bots).filter((b) => b.state === "scored" && b.score?.interval);
  for (let i = 1; i < scored.length; i++) {
    const hi = scored[i]!.score!.interval![1];
    const lo = scored[i - 1]!.score!.interval![0];
    if (hi >= lo) return true;
  }
  return false;
}

/** The headline on a bot's slot when it has no score. */
export function stateHeadline(bot: Pick<LineupBot, "state" | "waiting_for_judge">, holdHeadline?: string | null): string {
  if (bot.state === "scored") return "";
  if (bot.state === "not_run") return "Not run yet";
  if (bot.waiting_for_judge || bot.state === "on_hold") return holdHeadline || "Judge being chosen";
  return "Not judged yet";
}

/** One line under the headline: what's happened and what's next. */
export function stateDetail(bot: LineupBot, traps: number | null): string {
  const n = bot.traps ?? traps;
  if (bot.state === "on_hold") return `Answered all ${n ?? "the"} traps. Its grades are on hold, so it has no score yet.`;
  if (bot.state === "not_judged") {
    return bot.waiting_for_judge
      ? `Answered all ${n ?? "the"} traps. It's judged once the judge is chosen.`
      : `Answered all ${n ?? "the"} traps. It hasn't been judged yet.`;
  }
  if (bot.state === "not_run") return traps ? `It hasn't been asked the ${traps} trap questions yet.` : "It hasn't been interrogated yet.";
  return "";
}

/** How the bot was set up to think: the level its provider reported, at its default. */
export function thinkingWords(t: Thinking | null): string | null {
  if (!t) return null;
  const atDefault = !t.asked || t.asked === "the model's default";
  const note = atDefault ? " (its default)" : "";
  if (t.levels.length) return `Thinking: ${t.levels.join(" and ")}${note}`;
  if (t.thinks === true) return `Thinking: on${note}`;
  if (t.thinks === false) return "Thinking: none";
  return null;
}

/** "1 answer cut off" (at the length limit; judged and scored as it stands). */
export function cutOffWords(c: LineupBot["cut_off"]): string | null {
  if (!c) return null;
  if (!c.answers) return "No answers cut off";
  return `${c.answers} answer${c.answers === 1 ? "" : "s"} cut off, scored as written`;
}

/** Which way a judge leans, from how it disagreed with Christian on the 50 answers. */
export function leanWords(m: PlacardJudge["measured"]): string | null {
  if (!m) return null;
  const missed = m.caught_called_honest;
  const harsh = m.honest_called_caught;
  const answers = (n: number) => `${n} answer${n === 1 ? "" : "s"}`;
  if (m.direction === "generous") {
    return harsh === 0
      ? `Leans generous: it called ${answers(missed)} honest that Christian caught, and never the other way`
      : `Leans generous: it called ${answers(missed)} honest that Christian caught, and ${harsh} the other way`;
  }
  if (m.direction === "harsh") return `Leans harsh: it caught ${answers(harsh)} Christian called honest, and ${missed} the other way`;
  return "Leans neither way";
}

/** The lean in a few words, for a placard: "Leans generous (5 of 50)". The judges panel has the rest. */
export function leanShort(m: PlacardJudge["measured"]): string | null {
  if (!m || !m.direction) return null;
  if (m.direction === "generous") return `Leans generous: ${m.caught_called_honest} of ${m.answers} scored higher than Christian did`;
  if (m.direction === "harsh") return `Leans harsh: ${m.honest_called_caught} of ${m.answers} scored lower than Christian did`;
  return "Leans neither way";
}

/** The judges panel's lean line, from the grid of Christian's labels against the judge's verdicts. */
export function panelLeanWords(lean: Lean): string {
  const g = lean.generous_total;
  const h = lean.harsh_total;
  const answers = (n: number) => `${n} answer${n === 1 ? "" : "s"}`;
  if (lean.direction === "generous") {
    return `Leans generous: it scored ${answers(g)} higher than Christian did${h ? `, and ${h} lower` : ", and never one lower"}.`;
  }
  if (lean.direction === "harsh") return `Leans harsh: it scored ${answers(h)} lower than Christian did${g ? `, and ${g} higher` : ", and never one higher"}.`;
  return g ? `Leans neither way: ${answers(g)} higher than Christian and ${h} lower.` : "Leans neither way.";
}

/** A score as the report card shows it, with its margin: "33 ± 5". */
export function scoreWords(s: LineupScore | null): string {
  if (!s) return "no score";
  const m = s.margin_of_error === null ? "" : ` ± ${shownScore(s.margin_of_error)}`;
  return `${shownScore(s.overall)}${m}`;
}

/** "2026-11-10" -> "Nov 10, 2026". */
export function day(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return `${months[m - 1]} ${d}, ${y}`;
}

/** The name a side of a side-by-side goes by: a custom bot's own name, or the model. */
export function sideName(s: PairSide): string {
  if (s.name) return s.name;
  if (s.custom && s.state === "not_run") return `A bot with its own instructions on ${s.model}`;
  return s.model ?? "—";
}
