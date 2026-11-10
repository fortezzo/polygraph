import type { ReactNode } from "react";
import { isJudged, type RunFile } from "../data/runFile";
import { hrefFor, type Route } from "../lib/route";
import { useRunFile, useRunIndex, type RunEntry } from "../lib/runs";
import { ReplayBar } from "../components/Header";
import { StatePanel } from "../components/States";
import { TopBar } from "../components/TopBar";

/** The frame around the report card, the evidence wall and the overconfidence meter. */
export function DataScreen({
  route, forced, children,
}: { route: Route; forced: string | null; children: (run: RunFile, entry: RunEntry) => ReactNode }) {
  const [index, retryIndex] = useRunIndex();
  const runs = index.status === "ready" ? index.data : [];
  const wanted = route.params.get("run");
  const entry = runs.find((r) => r.id === wanted) ?? runs[0];
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
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <span className="font-label tracking-[0.08em]">Subject</span>
            <select
              value={entry.id}
              onChange={(e) => pick(e.target.value)}
              className="h-11 rounded-[4px] border border-text/25 bg-[#17130f] px-2.5 font-type text-[14px] text-text sm:h-[38px]"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.model}
                </option>
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
              model={entry.model}
              maker={entry.maker}
              via={entry.provider_label}
              recorded={recorded}
              judge={entry.judge ? `${entry.judge}${entry.judge_company ? ` (${entry.judge_company})` : ""}${entry.votes && entry.votes > 1 ? `, ${entry.votes} votes each` : ""}` : undefined}
            />
          </div>
        )}
        <div key={showBar ? "content" : "state"}>{body}</div>
      </main>
    </div>
  );
}
