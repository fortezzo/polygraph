// The evidence wall's filters. They live in the address, so a filtered wall can
// be bookmarked or shared: #/evidence?run=…&type=fake_citation&verdict=LIE,CAVED

import type { RunFile, TrapResult, Verdict } from "../data/runFile";
import { VERDICTS } from "../data/runFile";
import { confidenceFor, TRAP_TYPES } from "./report";

/** The wall opens on the caught answers. Honest and Dodged are one click away. */
export const DEFAULT_VERDICTS: readonly Verdict[] = ["LIE", "CAVED", "CONTRADICTED"];

export interface EvidenceFilters {
  type: string | null;
  verdicts: Verdict[];
  sort: "order" | "confident";
  trap: string | null;
}

export function readFilters(params: URLSearchParams): EvidenceFilters {
  const type = params.get("type");
  const v = params.get("verdict");
  const verdicts = v === null ? [...DEFAULT_VERDICTS] : (v.split(",").filter((x) => (VERDICTS as readonly string[]).includes(x)) as Verdict[]);
  return {
    type: TRAP_TYPES.some((t) => t.key === type) ? type : null,
    verdicts,
    sort: params.get("sort") === "confident" ? "confident" : "order",
    trap: params.get("trap"),
  };
}

export function filtersToParams(f: EvidenceFilters): Record<string, string | null> {
  const same = f.verdicts.length === DEFAULT_VERDICTS.length && DEFAULT_VERDICTS.every((v) => f.verdicts.includes(v));
  return {
    type: f.type,
    verdict: same ? null : VERDICTS.filter((v) => f.verdicts.includes(v)).join(","),
    sort: f.sort === "confident" ? "confident" : null,
    trap: f.trap,
  };
}

const matches = (t: TrapResult, f: Pick<EvidenceFilters, "type" | "verdicts">) =>
  (!f.type || t.type === f.type) && t.verdict !== null && f.verdicts.includes(t.verdict);

export function filterTraps(run: RunFile, f: EvidenceFilters): TrapResult[] {
  if (f.trap) return run.traps.filter((t) => t.id === f.trap);
  const shown = run.traps.filter((t) => matches(t, f));
  if (f.sort === "confident") {
    const order = new Map(run.traps.map((t, i) => [t.id, i]));
    const conf = (t: TrapResult) => confidenceFor(run, t.id)?.confidence ?? -1;
    shown.sort((a, b) => conf(b) - conf(a) || order.get(a.id)! - order.get(b.id)!);
  }
  return shown;
}

/** How many cards each trap-type button would show, with the verdicts picked now. */
export function typeCounts(run: RunFile, verdicts: Verdict[]): Record<string, number> {
  const out: Record<string, number> = { all: 0 };
  for (const t of TRAP_TYPES) out[t.key] = 0;
  for (const t of run.traps) {
    if (t.verdict === null || !verdicts.includes(t.verdict)) continue;
    out.all = (out.all ?? 0) + 1;
    out[t.type] = (out[t.type] ?? 0) + 1;
  }
  return out;
}

/** How many cards each verdict button covers, with the trap type picked now. */
export function verdictCounts(run: RunFile, type: string | null): Record<Verdict, number> {
  const out = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const t of run.traps) if (t.verdict && (!type || t.type === type)) out[t.verdict] += 1;
  return out;
}
