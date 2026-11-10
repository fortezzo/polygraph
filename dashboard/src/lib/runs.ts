// Loads the judged runs that scripts/export-runs.mjs copied into the dashboard.

import { useCallback, useEffect, useState } from "react";
import { readRun, type RunFile } from "../data/runFile";

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

export interface RunEntry {
  id: string;
  file: string;
  source: string | null;
  model: string;
  provider_label: string;
  maker: string | null;
  judge: string | null;
  judge_company: string | null;
  votes: number | null;
  started_at: string;
  recorded_first: string;
  recorded_last: string;
  traps: number;
  scored: number;
  overall: number | null;
  grade: string | null;
  margin_of_error: number | null;
  judge_check: JudgeCheck | null;
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

export function useRunIndex(): [Load<RunEntry[]>, () => void] {
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
    return runs;
  });
}

export function useRunFile(entry: RunEntry | undefined): [Load<RunFile>, () => void] {
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
