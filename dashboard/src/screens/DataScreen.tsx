import { useEffect, type ReactNode } from "react";
import { isJudged, type RunFile } from "../data/runFile";
import { hrefFor, type Route } from "../lib/route";
import { chosenRun, entryDisplay, lineupGradeOf, pickerGroups, pickerLabel, prefetchRun, subjectOf, useRunFile, useRunIndex, type RunCopy, type RunEntry } from "../lib/runs";
import { readFilters } from "../lib/evidence";
import { CAUGHT } from "../lib/report";
import { modelName } from "../lib/models";
import { Picker, SubjectBar } from "../components/Header";
import { StatePanel } from "../components/States";
import { TopBar } from "../components/TopBar";
import { day as holdDay } from "../lib/lineup";

/** "Nov 9, 2026" and "Nov 10, 2026" -> "Nov 9 – 10, 2026"; other ranges stay whole. */
function sameMonthRange(first: string, last: string): string {
  if (first === last) return first;
  const a = /^(\w+) (\d+), (\d{4})$/.exec(first);
  const b = /^(\w+) (\d+), (\d{4})$/.exec(last);
  if (a && b && a[1] === b[1] && a[3] === b[3]) return `${a[1]} ${a[2]} – ${b[2]}, ${a[3]}`;
  return `${first} – ${last}`;
}

/**
 * Session 10 (Christian): every screen opens on the lineup's own grades. Anything
 * else stays reachable, and says what it is: a second opinion, an earlier run, or
 * a run outside the lineup. (Replaced grades have their own notice below.)
 */
function RoleNote({ entry, runs, screen }: { entry: RunEntry; runs: RunEntry[]; screen: Route["screen"] }) {
  const own = lineupGradeOf(entry, runs);
  const link = own && (
    <a href={hrefFor(screen, { run: own.id })} className="text-brass underline underline-offset-2">
      {entry.role === "earlier" ? `See ${subjectOf(own)}’s ${own.traps}-trap run` : `See ${modelName(own.judge)}’s grades of the same answers`}
    </a>
  );
  const judge = modelName(entry.judge);
  let kicker: string;
  let words: string;
  if (entry.role === "second_opinion") {
    kicker = "SECOND OPINION";
    words = `Every verdict and score on this screen is ${judge}’s, kept as a second opinion next to the lineup’s grades.${own ? ` The lineup’s grades are ${modelName(own.judge)}’s.` : ""}`;
  } else if (entry.role === "earlier") {
    kicker = "EARLIER RUN";
    words = `${entry.traps} traps from the first trap library, graded by ${judge} and recorded ${entry.recorded_first}. The lineup asks every bot all 200.`;
  } else if (entry.role === "other") {
    kicker = "NOT IN THE LINEUP";
    words = `This run isn’t one the lineup counts. It was graded by ${judge}.`;
  } else return null;
  return (
    <aside
      aria-label={kicker.toLowerCase()}
      className="mt-3 flex flex-col gap-1.5 rounded-[4px] border border-brass/50 bg-brass/[0.07] px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
    >
      <span className="shrink-0 font-label text-[13px] tracking-[0.14em] text-brass">{kicker}</span>
      <p className="m-0 text-[14px] leading-relaxed text-soft">
        {words} {link}
      </p>
    </aside>
  );
}

/** The frame around the report card, the evidence wall and the overconfidence meter. */
export function DataScreen({
  route, forced, children,
}: { route: Route; forced: string | null; children: (run: RunFile, entry: RunEntry) => ReactNode }) {
  const [index, retryIndex] = useRunIndex();
  const runs = index.status === "ready" ? index.data.runs : [];
  const wanted = route.params.get("run");
  const entry = index.status === "ready" ? chosenRun(index.data, wanted) : undefined;
  // Session 11: the report card and the overconfidence meter open on the run's light
  // copy, and the evidence wall on its caught answers, unless its filters show
  // Honest or Dodged answers or a single card (then the whole run).
  const copy: RunCopy =
    route.screen !== "evidence" ? "light" : route.params.get("trap") || readFilters(route.params).verdicts.some((v) => !CAUGHT.includes(v)) ? "full" : "caught";
  const [file, retryFile] = useRunFile(forced ? undefined : entry, copy);
  // Once the caught answers are up, fetch the whole run in the background, so other filters are instant.
  useEffect(() => {
    if (copy !== "caught" || file.status !== "ready" || !entry) return;
    const t = window.setTimeout(() => (window as unknown as { __noPrefetch?: boolean }).__noPrefetch || prefetchRun(entry), 1500);
    return () => window.clearTimeout(t);
  }, [copy, file.status, entry]);

  const pick = (id: string) => {
    const params: Record<string, string | null> = Object.fromEntries(route.params.entries());
    params.run = id;
    params.trap = null; // a single card belongs to the other run
    window.location.hash = hrefFor(route.screen, params);
  };

  let body: ReactNode;
  if (index.status === "loading" && !forced) {
    // Session 11: while the short list of runs loads, the subject bar's place holder
    // already says "Opening the case file…". Nothing goes under it yet, so nothing
    // is pushed down when the bar takes its final size.
    body = null;
  } else if (forced === "loading" || (entry && file.status === "loading" && !forced)) {
    body = <StatePanel kicker="LOADING" title="Opening the case file…" live="polite" />;
  } else if (forced === "error") {
    body = (
      <StatePanel kicker="SOMETHING WENT WRONG" title="The recording couldn't be loaded" live="assertive" onRetry={() => {}}>
        <p className="m-0">Couldn&rsquo;t open the run file for this bot (the server said 503). Check your connection and try again.</p>
      </StatePanel>
    );
  } else if (index.status === "error") {
    body = (
      <StatePanel kicker="SOMETHING WENT WRONG" title={index.title} live="assertive" onRetry={retryIndex}>
        <p className="m-0">{index.detail}</p>
      </StatePanel>
    );
  } else if (forced === "empty" || !entry) {
    body = (
      <StatePanel kicker="NOTHING HERE YET" title="No judged interrogations yet">
        <p className="m-0">
          Interrogate a bot with <code className="rounded bg-white/8 px-1.5">polygraph run</code>, judge it with{" "}
          <code className="rounded bg-white/8 px-1.5">polygraph judge</code>, then start the dashboard again. Its report card shows up here.
        </p>
      </StatePanel>
    );
  } else if (file.status === "error") {
    body = (
      <StatePanel kicker="SOMETHING WENT WRONG" title={file.title} live="assertive" onRetry={retryFile}>
        <p className="m-0">{file.detail}</p>
      </StatePanel>
    );
  } else if (file.status === "ready" && !isJudged(file.data)) {
    body = (
      <StatePanel kicker="NOT JUDGED YET" title="This run hasn't been judged yet">
        <p className="m-0">
          Judge it with <code className="rounded bg-white/8 px-1.5">polygraph judge</code> and the run file, then start the dashboard again.
        </p>
      </StatePanel>
    );
  } else if (file.status === "ready") {
    body = children(file.data, entry);
  }
  // The notes about whose grades these are arrive with the case file, in the same
  // box, so they never push a loading message down (that would be the page jumping).
  const showBar = entry && !forced && file.status === "ready";
  // Session 11: the Subject picker sits in the subject bar, under the menu. While the
  // list of runs loads, its place is held at the same size, so nothing moves when it
  // arrives (on a phone the page jumped 38 px, which Lighthouse counted).
  const holdBar = !forced || forced === "loading";

  // "Nov 9 – 10, 2026", as the replay writes a range (Session 11).
  const recorded = entry ? sameMonthRange(entry.recorded_first, entry.recorded_last) : null;
  const shown = entry ? entryDisplay(entry) : null;
  const picker =
    entry && shown && !forced ? (
      <Picker
        label="Subject"
        value={entry.id}
        options={pickerGroups(runs).flatMap((g) => g.runs.map((r) => ({ id: r.id, label: pickerLabel(r, runs), group: g.label })))}
        main={shown.main}
        sub={shown.sub}
        onPick={pick}
      />
    ) : (
      <div aria-hidden="true" className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-[4px] border border-text/15 py-1.5 pl-3 sm:w-[300px] sm:flex-none">
        <span className="font-type text-[15px] leading-[20px] text-muted">Opening the case file…</span>
        <span className="font-type text-[12px] leading-[16px] text-transparent">.</span>
      </div>
    );
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 pt-3 pb-12 sm:px-6 lg:px-8 lg:pt-[18px]">
      <TopBar active={route.screen} run={entry?.id} />
      {holdBar && (
        <SubjectBar
          tag="case"
          picker={picker}
          maker={entry && !forced ? entry.maker : null}
          via={entry && !forced ? entry.provider_label : null}
          recorded={entry && !forced ? recorded : null}
          judge={
            entry?.judge && !forced
              ? `${modelName(entry.judge)}${entry.judge_company ? ` (${entry.judge_company})` : ""}${entry.votes && entry.votes > 1 ? `, ${entry.votes} votes each` : ""}`
              : null
          }
        />
      )}
      <main id="content" data-ready={file.status === "ready" && !forced ? "" : undefined} className="mt-2">
        {showBar && entry && (
          <div key="bar" className="mb-5 empty:hidden">
            <RoleNote entry={entry} runs={runs} screen={route.screen} />
            {entry.judge_hold && (
              // Session 9: this judge's grades are on hold, so its numbers here aren't final.
              <aside
                aria-label="Grades on hold"
                className="mt-3 flex flex-col gap-1.5 rounded-[4px] border border-lie/50 bg-lie/[0.07] px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
              >
                <span className="shrink-0 font-label text-[13px] tracking-[0.14em] text-lie">GRADES ON HOLD</span>
                <p className="m-0 text-[14px] leading-relaxed text-soft">
                  Every verdict and score on this screen is {modelName(entry.judge)}&rsquo;s. {entry.judge_hold.why}
                  {entry.judge_hold.since ? ` On hold since ${holdDay(entry.judge_hold.since)}.` : ""}{" "}
                  <a href={hrefFor("lineup", { judge: entry.judge })} className="text-brass underline underline-offset-2">
                    More in the lineup
                  </a>
                </p>
              </aside>
            )}
            {entry.judge_replaced && (
              // Session 9: this judge was replaced, so its grades don't count.
              <aside
                aria-label="Grades replaced"
                className="mt-3 flex flex-col gap-1.5 rounded-[4px] border border-lie/50 bg-lie/[0.07] px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
              >
                <span className="shrink-0 font-label text-[13px] tracking-[0.14em] text-lie">GRADES REPLACED</span>
                <p className="m-0 text-[14px] leading-relaxed text-soft">
                  Every verdict and score on this screen is {modelName(entry.judge)}&rsquo;s. {entry.judge_replaced.why}
                  {entry.judge_replaced.since ? ` Replaced on ${holdDay(entry.judge_replaced.since)}.` : ""}{" "}
                  <a href={hrefFor("lineup", { judge: entry.judge })} className="text-brass underline underline-offset-2">
                    More in the lineup
                  </a>
                  {(() => {
                    // Session 10: straight to the grades that count, for the same answers.
                    const own = lineupGradeOf(entry, runs);
                    return own ? (
                      <>
                        {" · "}
                        <a href={hrefFor(route.screen, { run: own.id })} className="text-brass underline underline-offset-2">
                          See {modelName(own.judge)}&rsquo;s grades of the same answers
                        </a>
                      </>
                    ) : null;
                  })()}
                </p>
              </aside>
            )}
          </div>
        )}
        <div key={showBar ? "content" : "state"}>{body}</div>
      </main>
    </div>
  );
}
