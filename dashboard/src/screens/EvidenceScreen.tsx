import { useEffect, useState, type ReactNode } from "react";
import type { RunFile, Verdict } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { DEFAULT_VERDICTS, filterTraps, filtersToParams, readFilters, typeCounts, verdictCounts, type EvidenceFilters } from "../lib/evidence";
import { TRAP_TYPES } from "../lib/report";
import { hrefFor, replaceHash, type Route } from "../lib/route";
import type { RunEntry } from "../lib/runs";
import { EvidenceCard } from "../components/EvidenceCard";
import { Icon } from "../components/Icon";
import { StatePanel } from "../components/States";
import { VERDICT_BRIGHT } from "../components/VerdictBadge";

// The caught verdicts first: they're what the wall is for.
const WALL_ORDER: readonly Verdict[] = ["LIE", "CAVED", "CONTRADICTED", "DODGED", "HONEST"];

// The button's visible words are its name for screen readers and voice control too.
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex h-11 items-center gap-1.5 whitespace-nowrap rounded-[4px] border px-3 font-label text-[13px] tracking-[0.02em] transition-colors sm:h-9 ${
        on ? "border-brass bg-brass text-room" : "border-text/25 bg-white/[0.03] text-text hover:bg-white/[0.08]"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Session 11: the wall shows its first few cards straight away and adds the rest a
 * few at a time, between frames, so the page never freezes while about a hundred
 * cards are laid out (it froze a phone for about a second and a half). Cards are
 * only ever added after the ones showing, so nothing on screen moves.
 */
// A phone shows a card or two at first; a laptop shows a few columns.
const FIRST_CARDS = typeof window !== "undefined" && window.innerWidth < 768 ? 2 : 6;
const MORE_CARDS = 1;

function useGrowingCount(total: number, key: string): number {
  const [count, setCount] = useState(FIRST_CARDS);
  const [forKey, setForKey] = useState(key);
  if (forKey !== key) {
    setForKey(key);
    setCount(FIRST_CARDS);
  }
  useEffect(() => {
    if (count >= total) return;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const cancel = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
    const grow = () => setCount((n) => Math.min(total, n + MORE_CARDS));
    if (idle && cancel) {
      const id = idle(grow, { timeout: 200 });
      return () => cancel(id);
    }
    const id = window.setTimeout(grow, 16);
    return () => window.clearTimeout(id);
  }, [count, total]);
  return Math.min(count, total);
}

/** The evidence wall: one card per caught answer, with filters (PLAN.md section 2.2). */
export function EvidenceScreen({ run, entry, route }: { run: RunFile; entry: RunEntry; route: Route }) {
  const f = readFilters(route.params);
  const shown = filterTraps(run, f);
  const showing = useGrowingCount(shown.length, `${entry.id}|${route.params.toString()}`);
  const types = typeCounts(run, f.verdicts);
  const verdicts = verdictCounts(run, f.type);
  const go = (patch: Partial<EvidenceFilters>) => replaceHash(hrefFor("evidence", { run: entry.id, ...filtersToParams({ ...f, ...patch }) }));
  const toggle = (v: Verdict) => go({ verdicts: f.verdicts.includes(v) ? f.verdicts.filter((x) => x !== v) : [...f.verdicts, v], trap: null });
  const isDefault = !f.type && f.sort === "order" && filtersToParams(f).verdict === null;

  return (
    <section aria-labelledby="wall-title">
      <h1 id="wall-title" className="sr-only">Evidence wall</h1>
      {f.trap ? (
        <p className="mb-5 text-[14px] text-soft">
          Showing one card.{" "}
          <a href={hrefFor("evidence", { run: entry.id })} className="text-brass underline underline-offset-2">
            Show the whole wall
          </a>
        </p>
      ) : (
        <div className="mb-6 flex flex-col gap-3">
          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-1.5 font-label text-[12px] tracking-[0.16em] text-muted">TRAP TYPE</legend>
            {/* Session 11: on a phone the trap types are one row to swipe through, fading
                at the edge, instead of four rows before the first card. */}
            <div className="-mx-4 -my-1.5 flex gap-1.5 overflow-x-auto px-4 py-1.5 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-36px),transparent)] sm:mx-0 sm:my-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:py-0 sm:[mask-image:none]">
              <Chip on={!f.type} onClick={() => go({ type: null })}>
                All <span className="opacity-70">{types.all}</span>
              </Chip>
              {TRAP_TYPES.map((t) => (
                <Chip key={t.key} on={f.type === t.key} onClick={() => go({ type: f.type === t.key ? null : t.key })}>
                  <span className="sm:hidden">{t.short}</span>
                  <span className="hidden sm:inline">{t.label}</span> <span className="opacity-70">{types[t.key] ?? 0}</span>
                </Chip>
              ))}
            </div>
          </fieldset>
          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-1.5 font-label text-[12px] tracking-[0.16em] text-muted">VERDICT</legend>
            <div className="flex flex-wrap gap-1.5">
              {WALL_ORDER.map((v) => {
                const on = f.verdicts.includes(v);
                return (
                  <Chip key={v} on={on} onClick={() => toggle(v)}>
                    <span className={on ? "" : VERDICT_BRIGHT[v].split(" ")[0]}>
                      <Icon name={VERDICT_INFO[v].icon} className="h-3.5 w-3.5" strokeWidth={2.8} />
                    </span>
                    {VERDICT_INFO[v].word.charAt(0) + VERDICT_INFO[v].word.slice(1).toLowerCase()} <span className="opacity-70">{verdicts[v]}</span>
                  </Chip>
                );
              })}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px] text-soft">
            <span aria-live="polite">
              <b className="text-text">{shown.length}</b> {shown.length === 1 ? "answer" : "answers"}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="font-label text-[12px] tracking-[0.12em] text-muted">ORDER</span>
              <Chip on={f.sort === "order"} onClick={() => go({ sort: "order" })}>As asked</Chip>
              <Chip on={f.sort === "confident"} onClick={() => go({ sort: "confident" })}>Most confident first</Chip>
            </span>
            {!isDefault && (
              <button type="button" onClick={() => go({ type: null, verdicts: [...DEFAULT_VERDICTS], sort: "order" })} className="h-11 text-brass underline underline-offset-2">
                Reset the filters
              </button>
            )}
          </div>
        </div>
      )}
      {shown.length ? (
        // grid-cols-1 lets a column shrink below its longest unbreakable word (a URL, a
        // line of code), so a card never runs off the side of a phone.
        <div className="grid grid-cols-1 items-start gap-x-5 gap-y-8 pt-2 md:grid-cols-2 2xl:grid-cols-3" data-complete={showing >= shown.length ? "" : undefined}>
          {shown.slice(0, showing).map((t) => (
            <EvidenceCard key={t.id} run={run} trap={t} />
          ))}
        </div>
      ) : (
        <StatePanel kicker="NO MATCHES" title="Nothing matches these filters" onRetry={() => go({ type: null, verdicts: [...DEFAULT_VERDICTS], sort: "order", trap: null })} retryLabel="Reset the filters">
          <p className="m-0">
            {f.verdicts.length === 0
              ? "No verdict is picked. Pick at least one."
              : `This bot has no ${f.verdicts.map((v) => VERDICT_INFO[v].word.toLowerCase()).join(" or ")} answers${f.type ? ` in ${TRAP_TYPES.find((t) => t.key === f.type)?.label}` : ""}.`}
          </p>
        </StatePanel>
      )}
    </section>
  );
}
