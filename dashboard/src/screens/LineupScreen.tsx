import type { ReactNode } from "react";
import type { Route } from "../lib/route";
import { useLineup } from "../lib/runs";
import { LineupView } from "../components/Lineup";
import { StatePanel } from "../components/States";
import { TopBar } from "../components/TopBar";

/** The lineup (Session 9): every bot on one height-chart wall, its judges, and the side-by-sides. */
export function LineupScreen({ route, forced }: { route: Route; forced: string | null }) {
  const [load, retry] = useLineup();
  const ready = load.status === "ready" && !forced;

  let body: ReactNode;
  if (forced === "loading" || load.status === "loading") {
    body = <StatePanel kicker="LOADING" title="Bringing in the lineup…" live="polite" />;
  } else if (forced === "error") {
    body = (
      <StatePanel kicker="SOMETHING WENT WRONG" title="The lineup couldn't be loaded" live="assertive" onRetry={() => {}}>
        <p className="m-0">Couldn&rsquo;t open the list of runs (the server said 503). Check your connection and try again.</p>
      </StatePanel>
    );
  } else if (load.status === "error") {
    body = (
      <StatePanel kicker="SOMETHING WENT WRONG" title={load.title} live="assertive" onRetry={retry}>
        <p className="m-0">{load.detail}</p>
      </StatePanel>
    );
  } else if (forced === "empty" || !load.data || load.data.bots.length === 0) {
    body = (
      <StatePanel kicker="NOTHING HERE YET" title="No lineup yet">
        <p className="m-0">
          The lineup is the list of bots in <code className="rounded bg-white/8 px-1.5">dashboard/src/data/lineup.json</code>. Interrogate each one
          with <code className="rounded bg-white/8 px-1.5">polygraph run</code>, judge it with{" "}
          <code className="rounded bg-white/8 px-1.5">polygraph judge</code>, then start the dashboard again.
        </p>
      </StatePanel>
    );
  } else {
    body = <LineupView lineup={load.data} focusJudge={route.params.get("judge")} />;
  }

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 pt-3 pb-12 sm:px-6 lg:px-8 lg:pt-[18px]">
      <TopBar active="lineup" />
      <main id="content" data-ready={ready ? "" : undefined} className="mt-3">
        {body}
      </main>
    </div>
  );
}
