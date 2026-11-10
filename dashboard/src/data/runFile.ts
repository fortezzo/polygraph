// The parts of a Polygraph run file (PLAN.md section 7) that the dashboard uses.
// The engine writes these files in runs/. The field names match it exactly.

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

export interface Judgement {
  decided_by?: string;
  phrase_answer?: number | null;
  own_knowledge?: boolean;
  unsettled?: boolean;
  votes?: { verdict: Verdict | null }[];
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
  };
  judge?: {
    provider_label?: string;
    model: string;
    model_version?: string;
    company?: string;
    bot_company?: string;
    rubric_fingerprint?: string;
    votes?: number;
  };
  prompts?: { confidence_question?: string; document_template?: string };
}

export interface RunFile {
  format: "polygraph-run";
  format_version: number;
  run: RunInfo;
  documents?: Record<string, { title: string; text: string }>;
  traps: TrapResult[];
  sample?: { made_from: string; rule: string };
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
