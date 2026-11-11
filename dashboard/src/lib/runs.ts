// Loads the judged runs that scripts/export-runs.mjs copied into the dashboard.

import { useCallback, useEffect, useState } from "react";
import { readRun, type RunFile } from "../data/runFile";
import type { LineupData } from "./lineup";
import { shownScore } from "./report";

export interface JudgeCheck {
  judge: string;
  answers: number;
  agree: number;
  percent: number;
  percent_range: [number, number];
  kappa: number;
  kappa_words: string;
  honest_called_caught: number;
  caught_called_honest: number;
}

/**
 * What a judged run is (Session 10, from scripts/export-runs.mjs). Every screen
 * opens on a "lineup" grade; the rest stay reachable, clearly labeled.
 */
export type RunRole = "lineup" | "unranked" | "second_opinion" | "replaced" | "earlier" | "other";

export interface RunEntry {
  id: string;
  file: string;
  source: string | null;
  /** The run file that was judged (in runs/): two judges' grades of the same answers share it. */
  judged_from?: string | null;
  role?: RunRole;
  model: string;
  /** A custom bot's name, like "Bob's Pizza bot" (Session 8). */
  name?: string | null;
  /** The bot had its own instructions (a system prompt). */
  custom?: boolean;
  provider_label: string;
  maker: string | null;
  judge: string | null;
  judge_company: string | null;
  votes: number | null;
  started_at: string;
  recorded_first: string;
  recorded_last: string;
  traps: number;
  /** How many of the 8 trap types the run tested. */
  types?: number;
  status?: string | null;
  scored: number;
  overall: number | null;
  grade: string | null;
  margin_of_error: number | null;
  judge_check: JudgeCheck | null;
  /** The judge's grades are on hold (Session 9): every screen says so next to them. */
  judge_hold?: { since: string | null; why: string | null } | null;
  /** The judge was replaced (Session 9): its grades don't count, and every screen says so. */
  judge_replaced?: { by: string | null; since: string | null; why: string | null } | null;
}

/** What to call the bot on screen: a custom bot's name with its model, or just the model. */
export function subjectOf(entry: Pick<RunEntry, "model" | "name">): string {
  return entry.name ? `${entry.name} (${entry.model})` : entry.model;
}

/** The run list, and the run every data screen opens on (always a lineup grade when there is one). */
export interface RunIndex {
  runs: RunEntry[];
  opensOn: string | null;
}

/** The run to show: the one in the address, or else the one the screens open on. */
export function chosenRun(index: RunIndex, wanted: string | null): RunEntry | undefined {
  const { runs, opensOn } = index;
  return runs.find((r) => r.id === wanted) ?? runs.find((r) => r.id === opensOn) ?? runs.find((r) => r.role === "lineup") ?? runs[0];
}

const ROLE_GROUP: Record<RunRole, (judge: string | null) => string> = {
  lineup: (j) => `The lineup, graded by ${j ?? "its judge"}`,
  unranked: (j) => `Not ranked: a bot with its own instructions, graded by ${j ?? "its judge"}`,
  second_opinion: (j) => `Second opinions, graded by ${j ?? "another judge"}`,
  replaced: () => "Replaced grades: they don't count",
  earlier: () => "Earlier runs, from the 80-trap library",
  other: () => "Other runs",
};

const ROLE_ORDER: RunRole[] = ["lineup", "unranked", "second_opinion", "replaced", "earlier", "other"];

/** The Subject picker's groups, in order, each with a label that says whose grades they are. */
export function pickerGroups(runs: RunEntry[]): { role: RunRole; label: string; runs: RunEntry[] }[] {
  return ROLE_ORDER.map((role) => {
    const these = runs.filter((r) => (r.role ?? "other") === role);
    const judges = [...new Set(these.map((r) => r.judge))];
    return { role, label: ROLE_GROUP[role](judges.length === 1 ? judges[0] ?? null : null), runs: these };
  }).filter((g) => g.runs.length > 0);
}

/**
 * A run's name in the Subject picker. A closed picker only shows this line, so
 * anything that isn't the lineup's own grade says what it is, and whose.
 */
export function pickerLabel(run: RunEntry, all: RunEntry[]): string {
  const base = (r: RunEntry): string => {
    const name = subjectOf(r);
    switch (r.role) {
      case "lineup":
        return name;
      case "unranked":
        return `${name} · not ranked`;
      case "second_opinion":
        return `${name} · second opinion by ${r.judge}`;
      case "replaced":
        return `${name} · replaced grades by ${r.judge}`;
      case "earlier":
        return `${name} · earlier ${r.traps}-trap run, ${r.recorded_first}`;
      default:
        return `${name} · ${r.traps} traps, ${r.recorded_first}, graded by ${r.judge}`;
    }
  };
  const label = base(run);
  if (all.filter((r) => base(r) === label).length < 2) return label;
  const time = /T(\d{2}):(\d{2})/.exec(run.started_at);
  return `${label}${time ? ` ${time[1]}:${time[2]}` : ""}`;
}

/** The lineup's own grade of the same answers, for a second opinion or replaced grades to point to. */
export function lineupGradeOf(entry: RunEntry, runs: RunEntry[]): RunEntry | undefined {
  const own = (r: RunEntry) => r.role === "lineup" || r.role === "unranked";
  const same = runs.find((r) => own(r) && r.judged_from && r.judged_from === entry.judged_from);
  if (same) return same;
  // An earlier run: the lineup's run of the same bot (a custom bot goes with the custom bot).
  return runs.find((r) => own(r) && r.model === entry.model && !!r.custom === !!entry.custom && (r.name ?? null) === (entry.name ?? null));
}

/** A recording's line in the replay's picker: the bot and its grade, rounded as the lineup shows it. */
export function recordingLabel(r: Recording): string {
  const score = shownScore(r.overall);
  const graded = score === null ? "not graded" : `${score} (${r.grade})`;
  return r.custom ? `${subjectOf(r)} · ${graded}, not ranked` : `${subjectOf(r)} · ${graded}`;
}

/** One recording the replay can play (scripts/export-runs.mjs, replays.json). */
export interface Recording {
  id: string;
  file: string;
  role: RunRole;
  model: string;
  name?: string | null;
  custom?: boolean;
  maker: string | null;
  provider_label: string;
  judge: string | null;
  judge_company: string | null;
  votes: number | null;
  traps: number;
  overall: number | null;
  grade: string | null;
  recorded_first: string;
  recorded_last: string;
}

/** Forget the runs loaded so far, so a run that just finished shows up (Session 8). */
export function forgetRuns(): void {
  cache.clear();
}

export type Load<T> =
  | { status: "loading" }
  | { status: "error"; title: string; detail: string }
  | { status: "ready"; data: T };

const cache = new Map<string, Promise<unknown>>();

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(res.status === 404 ? "not found" : `the server said ${res.status}`);
  return res.json();
}

function cached(url: string): Promise<unknown> {
  let p = cache.get(url);
  if (!p) {
    p = fetchJson(url);
    cache.set(url, p);
    p.catch(() => cache.delete(url)); // a failed load can be tried again
  }
  return p;
}

function useLoad<T>(key: string | null, load: () => Promise<T>): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    let live = true;
    setState({ status: "loading" });
    load().then(
      (data) => live && setState({ status: "ready", data }),
      (e: Error) => live && setState({ status: "error", title: "The recording couldn't be loaded", detail: e.message }),
    );
    return () => {
      live = false;
    };
    // `load` only changes when `key` does; `attempt` is the "Try again" button.
  }, [key, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}

export function useRunIndex(): [Load<RunIndex>, () => void] {
  return useLoad("index", async () => {
    let data: unknown;
    try {
      data = await cached("./runs/index.json");
    } catch {
      throw new Error(
        "The dashboard's copy of the runs is missing. Start the dashboard with npm run dev (or build it with npm run build), which makes it from the runs folder first.",
      );
    }
    const runs = (data as { runs?: RunEntry[] })?.runs;
    if (!Array.isArray(runs)) throw new Error("The list of runs is damaged. Run npm run runs in the dashboard folder to make it again.");
    const opensOn = (data as { opens_on?: string | null }).opens_on ?? null;
    return { runs, opensOn };
  });
}

/**
 * The replay's recordings (Session 10): a few KB on their own, so the first
 * page never waits for the full run list. Each recording loads when it's picked.
 */
export function useRecordings(): [Load<Recording[]>, () => void] {
  return useLoad("replays", async () => {
    let data: unknown;
    try {
      data = await cached("./runs/replays.json");
    } catch {
      throw new Error("The list of recordings couldn't be loaded. Check your connection and try again.");
    }
    const list = (data as { recordings?: Recording[] })?.recordings;
    if (!Array.isArray(list)) throw new Error("The list of recordings is damaged. Run npm run runs in the dashboard folder to make it again.");
    return list;
  });
}

/** The lineup (Session 9), from the same index.json. Null when the export made none. */
export function useLineup(): [Load<LineupData | null>, () => void] {
  return useLoad("lineup", async () => {
    let data: unknown;
    try {
      data = await cached("./runs/index.json");
    } catch {
      throw new Error(
        "The dashboard's copy of the runs is missing. Start the dashboard with npm run dev (or build it with npm run build), which makes it from the runs folder first.",
      );
    }
    const lineup = (data as { lineup?: LineupData | null })?.lineup ?? null;
    if (lineup !== null && !Array.isArray(lineup?.bots)) throw new Error("The lineup is damaged. Run npm run runs in the dashboard folder to make it again.");
    return lineup;
  });
}

export function useRunFile(entry: Pick<RunEntry, "file" | "model"> | undefined): [Load<RunFile>, () => void] {
  return useLoad(entry?.file ?? null, async () => {
    let data: unknown;
    try {
      data = await cached(`./runs/${entry!.file}`);
    } catch (e) {
      throw new Error(`Couldn't open the run file for ${entry!.model} (${(e as Error).message}). Check your connection and try again.`);
    }
    const r = readRun(data);
    if (!r.ok) throw new Error(r.detail);
    return r.run;
  });
}
