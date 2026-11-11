// The parts of a Polygraph run file (PLAN.md section 7) that the dashboard uses.
// The engine writes these files in runs/. The field names match it exactly.

import type { ConfirmedReference } from "../lib/names";

export type Verdict = "HONEST" | "LIE" | "CAVED" | "CONTRADICTED" | "DODGED";
export const VERDICTS: readonly Verdict[] = ["HONEST", "LIE", "CAVED", "CONTRADICTED", "DODGED"];

export interface Confidence {
  value: number | null;
  reply: string | null;
}

export interface Call {
  model_version?: string;
  first_collected_at?: string;
  seconds?: number;
  /** How hard the bot thought, as its provider reported it (OpenAI: "medium"...). Session 9. */
  thinking_level?: string | null;
  /** The answer hit the length limit and was cut off. It's judged and scored as it stands. */
  truncated?: boolean;
}

export interface Turn {
  role: "user" | "assistant";
  kind: string; // "question", "push_back" or "answer"
  content: string;
  call: Call | null;
  confidence: Confidence | null;
}

export interface Conversation {
  wording: number | null;
  turns: Turn[];
}

export interface TrapSpec {
  id: string;
  type: string;
  question: string;
  truth: string;
  source: { title: string; url: string | null; note?: string };
  follow_ups?: string[];
  honest_looks_like?: string;
  caught_if?: string;
  verified_on?: string;
  document?: string;
  answerable?: boolean;
  rewordings?: string[];
}

/** One reference a bot gave, as the hard check looked it up (fake-citation traps). */
export interface CheckedReference {
  number: number;
  label: "made up" | "real paper, wrong details" | "can't tell" | string;
  quote?: string | null;
  doi?: string | null;
  url?: string | null;
  title?: string | null;
  status?: string | null;
  wrong?: string[];
  real_paper?: { doi?: string | null; title?: string | null; years?: number[]; journal?: string | null } | null;
  /** It checks out, authors included: its authors' names can show (export-runs.mjs, Session 10). */
  confirmed?: ConfirmedReference | null;
}

export interface HardCheck {
  kind?: string; // "answer_key", "references" or "side_by_side"
  outcome?: string;
  summary?: string | null;
  details?: { references?: CheckedReference[] } | null;
}

export interface Judgement {
  decided_by?: string;
  phrase_answer?: number | null;
  own_knowledge?: boolean;
  unsettled?: boolean;
  votes?: { verdict: Verdict | null }[];
  hard_check?: HardCheck | null;
}

/** Christian's label from the Session 5 judge check (added by export-runs.mjs). */
export interface HandLabel {
  verdict: Verdict;
  unsure: boolean;
  item: string;
}

export interface TrapResult {
  id: string;
  type: string;
  label: string;
  status?: string;
  trap: TrapSpec;
  conversations: Conversation[];
  verdict: Verdict | null;
  made_up_phrase: string | null;
  reason: string | null;
  judgement: Judgement | null;
  hand_label?: HandLabel;
}

export interface CalibrationPoint {
  trap: string;
  type: string;
  answer: string | null;
  confidence: number | null;
  verdict: Verdict | null;
  points: number | null;
  reply: string | null;
  suspect: "zero" | "echo" | null;
}

export interface CalibrationBucket {
  low: number;
  high: number;
  answers: number;
  mean_confidence: number | null;
  honest_rate: number | null;
}

export interface CalibrationSummary {
  rated: number;
  mean_confidence: number | null;
  mean_confidence_honest: number | null;
  mean_confidence_caught: number | null;
  honest_rate: number | null;
  overconfidence: number | null;
  calibration_error: number | null;
  confident_and_caught: number;
}

export interface Calibration extends CalibrationSummary {
  points: CalibrationPoint[];
  buckets: CalibrationBucket[];
  unknown: number;
  suspect: number;
  suspect_zero: number;
  suspect_echo: number;
  without_suspect: CalibrationSummary;
  most_confident_lies: { trap: string; label: string; confidence: number; verdict: Verdict; made_up_phrase: string | null; reply: string | null }[];
}

export interface TypeScore {
  label: string;
  score: number | null;
  margin_of_error: number | null;
  interval: [number, number] | null;
  traps: number;
  verdicts: Partial<Record<Verdict, number>>;
}

export interface Scores {
  overall: number | null;
  grade: string | null;
  margin_of_error: number | null;
  interval: [number, number] | null;
  by_type: Record<string, number | null>;
  types: Record<string, TypeScore>;
  verdicts: Partial<Record<Verdict, number>>;
  traps_scored: number;
  traps_not_scored: number;
  calibration: Calibration | null;
}

export interface RunInfo {
  id: string;
  status?: string;
  started_at: string;
  finished_at?: string;
  target: {
    provider: string;
    provider_label: string;
    model: string;
    model_version?: string;
    model_details?: Record<string, string>;
    /** A custom bot (Session 8): its owner's instructions and the name it was given. */
    system_prompt?: string | null;
    name?: string | null;
  };
  judge?: {
    provider_label?: string;
    model: string;
    model_version?: string;
    company?: string;
    bot_company?: string;
    rubric_fingerprint?: string;
    votes?: number;
    counts?: { by_hard_check?: number; by_ai_judge?: number; split_votes?: number; unsettled?: number; own_knowledge?: number };
    /** Set when a custom bot's instructions were shown to the judge as background. */
    bot_instructions?: { fingerprint?: string; shown_as?: string } | null;
  };
  prompts?: { confidence_question?: string; document_template?: string };
  trap_set?: { version?: string; traps_in_run?: number };
}

export interface RunFile {
  format: "polygraph-run";
  format_version: number;
  run: RunInfo;
  documents?: Record<string, { title: string; text: string }>;
  traps: TrapResult[];
  scores?: Scores | null;
  sample?: { made_from: string; rule: string };
}

/** A run the report card can show: judged, with scores. */
export function isJudged(run: RunFile): boolean {
  return !!run.run.judge && !!run.scores && run.scores.traps_scored > 0;
}

export const SUPPORTED_FORMAT_VERSION = 1;

export type ReadResult =
  | { ok: true; run: RunFile }
  | { ok: false; title: string; detail: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks that something is a run file the dashboard can play, and says what's
 * wrong in plain English when it isn't. It checks the shape, not every field.
 */
export function readRun(data: unknown): ReadResult {
  const bad = (detail: string): ReadResult => ({ ok: false, title: "This recording can't be played", detail });
  if (!isObject(data) || data.format !== "polygraph-run") {
    return bad("It isn't a Polygraph run file. Run files are made by polygraph run and saved in the runs folder.");
  }
  if (typeof data.format_version !== "number" || data.format_version > SUPPORTED_FORMAT_VERSION) {
    return bad("It was made by a newer version of Polygraph than this dashboard understands.");
  }
  const run = data.run;
  if (!isObject(run) || !isObject(run.target) || typeof run.target.model !== "string" || typeof run.started_at !== "string") {
    return bad("The file is missing the details of which bot was interrogated and when.");
  }
  if (!Array.isArray(data.traps)) {
    return bad("The file has no list of questions.");
  }
  for (const [i, t] of data.traps.entries()) {
    if (!isObject(t) || typeof t.id !== "string" || !isObject(t.trap) || !Array.isArray(t.conversations)) {
      return bad(`Question ${i + 1} in the file is damaged.`);
    }
  }
  return { ok: true, run: data as unknown as RunFile };
}

/** The answers in a trap, in the order the bot gave them, across all chats. */
export function answersOf(trap: TrapResult): Turn[] {
  return trap.conversations.flatMap((c) => c.turns.filter((t) => t.role === "assistant"));
}
