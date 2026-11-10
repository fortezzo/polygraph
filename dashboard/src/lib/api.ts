// Talking to Polygraph's live server (Session 8, polygraph/server.py). In
// development the dashboard's own server passes /api through to it, so the
// browser only ever talks to one address.

export interface Problem {
  title: string;
  message: string;
  hint: string | null;
  kind: string;
}

/** The server isn't running (or the page wasn't opened by start.ps1). */
export const SERVER_DOWN: Problem = {
  title: "Polygraph's server isn't running",
  message: "Live runs need Polygraph's server on this PC, and it isn't answering.",
  hint: "In the run tab, run .\\start.ps1 from the Polygraph folder. It starts the server and the dashboard together.",
  kind: "server_down",
};

export class ApiError extends Error {
  constructor(public problem: Problem, public status = 0) {
    super(problem.message);
  }
}

/** Turns a failed response into a Problem: the server's own words, or "it isn't running". */
export async function problemFrom(res: Response): Promise<Problem> {
  try {
    const body = (await res.json()) as { problem?: Problem };
    if (body && body.problem && typeof body.problem.title === "string") return body.problem;
  } catch {
    // not JSON: the dashboard's server couldn't reach Polygraph's server
  }
  if (res.status >= 500 || res.status === 404) return SERVER_DOWN;
  return { title: "Something went wrong", message: `The server said ${res.status}.`, hint: null, kind: "error" };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new ApiError(SERVER_DOWN);
  }
  if (!res.ok) throw new ApiError(await problemFrom(res), res.status);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(SERVER_DOWN);
  }
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---- What the server sends ----------------------------------------------------

export interface BotOption {
  provider: string;
  provider_label?: string;
  model: string;
  maker: string | null;
  local: boolean;
  available: boolean;
  why_not: string | null;
  size?: string | null;
  price_in: number;
  price_out: number;
  thinks?: boolean;
  note?: string;
}

export interface JudgeOption extends BotOption {
  default: boolean;
}

export interface RunSummary {
  id: string;
  state: "starting" | "running" | "done";
  events: number;
  model: string;
  name: string | null;
  status: string;
}

export interface Setup {
  bots: BotOption[];
  judges: JudgeOption[];
  trap_types: { type: string; label: string; count: number }[];
  ollama: { ok: boolean; problem: Problem | null };
  keys: Record<string, boolean>;
  limit_usd: number;
  max_limit_usd: number;
  votes: number;
  run: RunSummary | null;
  pretend: boolean;
}

export interface Choices {
  bot_provider: string;
  bot_model: string;
  judge_provider: string | null;
  judge_model: string | null;
  types: string[];
  fresh: boolean | null;
  own_bot: { name: string; instructions: string } | null;
  max_cost: number;
}

export interface Plan {
  bot: { provider: string; provider_label: string; model: string; maker: string; local: boolean; name: string | null; version: string | null; size: string | null };
  judge: { provider: string; provider_label: string; model: string; maker: string; votes: number };
  traps: number;
  by_type: Record<string, number>;
  fresh: boolean;
  questions: number;
  saved: number;
  judge_questions: number;
  bot_usd: number;
  judge_usd: number;
  typical_usd: number;
  limit_usd: number;
  over_limit: boolean;
  suggested_limit_usd: number;
  free: boolean;
  confidence_question: string;
}

export const getSetup = () => call<Setup>("/api/setup");
export const getCurrent = () => call<{ run: RunSummary | null }>("/api/runs/current");
export const makePlan = (choices: Choices) => post<Plan>("/api/plan", choices);
export const startRun = (choices: Choices) => post<{ run: RunSummary }>("/api/runs", { ...choices, confirm: true });
export const stopRun = (id: string) => post<{ stopped: boolean }>(`/api/runs/${encodeURIComponent(id)}/stop`, {});
export const eventsUrl = (id: string) => `/api/runs/${encodeURIComponent(id)}/events`;

/** "$0.04", "$0.004", "free". */
export function usd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(amount < 0.001 ? 4 : 3)}`;
  return `$${amount.toFixed(2)}`;
}
