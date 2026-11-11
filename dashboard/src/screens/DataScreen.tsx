import type { ReactNode } from "react";
import { isJudged, type RunFile } from "../data/runFile";
import { hrefFor, type Route } from "../lib/route";
import { chosenRun, lineupGradeOf, pickerGroups, pickerLabel, subjectOf, useRunFile, useRunIndex, type RunEntry } from "../lib/runs";
import { ReplayBar } from "../components/Header";
import { StatePanel } from "../components/States";
import { TopBar } from "../components/TopBar";
import { day as holdDay } from "../lib/lineup";

/**
 * Session 10 (Christian): every screen opens on the lineup's own grades. Anything
 * else stays reachable, and says what it is: a second opinion, an earlier run, or
 * a run outside the lineup. (Replaced grades have their own notice below.)
 */
function RoleNote({ entry, runs, screen }: { entry: RunEntry; runs: RunEntry[]; screen: Route["screen"] }) {
  const own = lineupGradeOf(entry, runs);
  const link = own && (
    <a href={hrefFor(screen, { run: own.id })} className="text-brass underline underline-offset-2">
      {entry.role === "earlier" ? `See ${subjectOf(own)}’s ${own.traps}-trap run` : `See ${own.judge}’s grades of the same answers`}
    </a>
  );
  let kicker: string;
  let words: string;
  if (entry.role === "second_opinion") {
    kicker = "SECOND OPINION";
    words = `Every verdict and score on this screen is ${entry.judge}’s, kept as a second opinion next to the lineup’s grades.${own ? ` The lineup’s grades are ${own.judge}’s.` : ""}`;
  } else if (entry.role === "earlier") {
    kicker = "EARLIER RUN";
    words = `${entry.traps} traps from the first trap library, graded by ${entry.judge} and recorded ${entry.recorded_first}. The lineup asks every bot all 200.`;
  } else if (entry.role === "other") {
    kicker = "NOT IN THE LINEUP";
    words = `This run isn’t one the lineup counts. It was graded by ${entry.judge}.`;
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
  const [file, retryFile] = useRunFile(forced ? undefined : entry);

  const pick = (id: string) => {
    const params: Record<string, string | null> = Object.fromEntries(route.params.entries());
    params.run = id;
    params.trap = null; // a single card belongs to the other run
    window.location.hash = hrefFor(route.screen, params);
  };

  let body: ReactNode;
  if (forced === "loading" || index.status === "loading" || (entry && file.status === "loading" && !forced)) {
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
  // The case-file line arrives with the case file, inside the same box, so it
  // never pushes a loading message down (that would count as the page jumping).
  const showBar = entry && !forced && file.status === "ready";

  const recorded = entry ? (entry.recorded_first === entry.recorded_last ? entry.recorded_first : `${entry.recorded_first} – ${entry.recorded_last}`) : null;
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 pt-3 pb-12 sm:px-6 lg:px-8 lg:pt-[18px]">
      <TopBar active={route.screen} run={entry?.id}>
        {runs.length > 1 && entry && (
          <label className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
            <span className="font-label tracking-[0.08em]">Subject</span>
            <select
              value={entry.id}
              onChange={(e) => pick(e.target.value)}
              className="h-11 max-w-[calc(100vw-8.5rem)] min-w-0 rounded-[4px] border border-text/25 bg-[#17130f] px-2.5 font-type text-[14px] text-text sm:h-[38px] sm:max-w-[min(340px,calc(100vw-10rem))]"
            >
              {pickerGroups(runs).map((g) => (
                <optgroup key={g.role} label={g.label}>
                  {g.runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {pickerLabel(r, runs)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
      </TopBar>
      <main data-ready={file.status === "ready" && !forced ? "" : undefined}>
        {showBar && entry && (
          <div key="bar" className="mb-5">
            <ReplayBar
              tag="case"
              model={subjectOf(entry)}
              maker={entry.maker}
              via={entry.provider_label}
              recorded={recorded}
              judge={entry.judge ? `${entry.judge}${entry.judge_company ? ` (${entry.judge_company})` : ""}${entry.votes && entry.votes > 1 ? `, ${entry.votes} votes each` : ""}` : undefined}
            />
            <RoleNote entry={entry} runs={runs} screen={route.screen} />
            {entry.judge_hold && (
              // Session 9: this judge's grades are on hold, so its numbers here aren't final.
              <aside
                aria-label="Grades on hold"
                className="mt-3 flex flex-col gap-1.5 rounded-[4px] border border-lie/50 bg-lie/[0.07] px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
              >
                <span className="shrink-0 font-label text-[13px] tracking-[0.14em] text-lie">GRADES ON HOLD</span>
                <p className="m-0 text-[14px] leading-relaxed text-soft">
                  Every verdict and score on this screen is {entry.judge}&rsquo;s. {entry.judge_hold.why}
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
                  Every verdict and score on this screen is {entry.judge}&rsquo;s. {entry.judge_replaced.why}
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
                          See {own.judge}&rsquo;s grades of the same answers
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
