import { useEffect, useMemo, useRef, useState } from "react";
import { MotionConfig, useReducedMotion } from "motion/react";
import type { Verdict } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { ApiError, SERVER_DOWN, eventsUrl, getCurrent, stopRun, usd, type Problem, type RunSummary } from "../lib/api";
import { applyEvent, catchUp, EMPTY_LIVE, LIVE_PACE, LIVE_REDUCED_PACE, statusLine, tally, type LiveEvent, type LiveState } from "../lib/live";
import { LiveClock, liveTimeline, liveTrack } from "../lib/liveTimeline";
import { viewAt, viewKey } from "../lib/timeline";
import { onFrame } from "../lib/frame";
import { Sound } from "../lib/sound";
import { hrefFor, replaceHash, type Route } from "../lib/route";
import { forgetRuns } from "../lib/runs";
import { shownScore } from "../lib/report";
import { ChartPaper } from "../components/ChartPaper";
import { Transcript } from "../components/Transcript";
import { CaseDetails, CaseSummary } from "../components/CaseNotes";
import { Icon } from "../components/Icon";
import { StatePanel } from "../components/States";
import { TopBar } from "../components/TopBar";

// The needle's line in a live run (Christian approved the wording in Session 8).
const NEEDLE_NOTE = "The needle jumps when Polygraph’s judge finds made-up words, right after it reads each answer. It’s not a live signal from the bot.";

const EVENT_TYPES = [
  "run_started", "trap_started", "question", "answer_chunk", "answer_restart", "answer", "confidence",
  "trap_answered", "judging", "verdict", "retrying", "error", "stopping", "run_finished",
];

type Connection = { status: "loading" } | { status: "none" } | { status: "problem"; problem: Problem } | { status: "ready"; run: RunSummary };

/** The interrogation room, live: a run started from the New interrogation screen. */
export function LiveScreen({ route }: { route: Route }) {
  const reduced = useReducedMotion() ?? false;
  const [connection, setConnection] = useState<Connection>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Coming straight from "Start the interrogation": show it all from the first
  // question, even what the server did before the page opened (like answers it
  // had saved). A reload just catches up. The flag comes off the address, so a
  // reload is a reload.
  const [fromStart] = useState(() => route.params.get("from") === "start");
  useEffect(() => {
    if (route.params.get("from") === "start") replaceHash(hrefFor("live"));
  }, [route]);

  useEffect(() => {
    let live = true;
    setConnection({ status: "loading" });
    getCurrent().then(
      ({ run }) => live && setConnection(run ? { status: "ready", run } : { status: "none" }),
      (e: unknown) => live && setConnection({ status: "problem", problem: e instanceof ApiError ? e.problem : SERVER_DOWN }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (connection.status !== "ready") {
    return (
      <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 pt-3 pb-12 sm:px-6 lg:px-8 lg:pt-[18px]">
        <TopBar active="live" />
        <main>
          {connection.status === "loading" && <StatePanel kicker="LOADING" title="Opening the interrogation room…" live="polite" />}
          {connection.status === "none" && (
            <StatePanel kicker="NOTHING LIVE" title="No interrogation is going right now">
              <p className="m-0">
                Start one on the <a className="text-brass underline underline-offset-2" href={hrefFor("new")}>New interrogation</a> screen. Finished runs are on the report card.
              </p>
            </StatePanel>
          )}
          {connection.status === "problem" && (
            <StatePanel kicker="SOMETHING WENT WRONG" title={connection.problem.title} live="assertive" onRetry={() => setAttempt((n) => n + 1)}>
              <p className="m-0">{connection.problem.message}</p>
              {connection.problem.hint && <p className="mt-2 mb-0">{connection.problem.hint}</p>}
            </StatePanel>
          )}
        </main>
      </div>
    );
  }
  return <LiveRoom key={connection.run.id} run={connection.run} reduced={reduced} fromStart={fromStart} />;
}

function LiveRoom({ run, reduced, fromStart }: { run: RunSummary; reduced: boolean; fromStart: boolean }) {
  const clock = useMemo(() => new LiveClock(), []);
  const pace = reduced ? LIVE_REDUCED_PACE : LIVE_PACE;
  const [state, setState] = useState<LiveState>(EMPTY_LIVE);
  const [link, setLink] = useState<"open" | "reconnecting">("open");
  const sound = useMemo(() => new Sound(), []);
  const [soundOn, setSoundOn] = useState(false);
  const [stopAsked, setStopAsked] = useState(false);

  // Follow the run's events. What happened before the page opened (a reload)
  // is laid out at once, as if the screen had been watching; the rest shows
  // as it happens.
  useEffect(() => {
    const history = fromStart ? 0 : run.events;
    const earlier: LiveEvent[] = [];
    let caughtUp = history === 0;
    const source = new EventSource(eventsUrl(run.id));
    const take = (message: MessageEvent<string>) => {
      let e: LiveEvent;
      try {
        e = JSON.parse(message.data) as LiveEvent;
      } catch {
        return;
      }
      if (!caughtUp) {
        if (e.id <= history) earlier.push(e);
        if (e.id < history) return;
        caughtUp = true;
        const past = catchUp(earlier, clock.now(), pace);
        setState(e.id <= history ? past : applyEvent(past, e, clock.now(), pace));
      } else {
        setState((s) => applyEvent(s, e, clock.now(), pace));
      }
      setLink("open");
      if (e.type === "run_finished") {
        source.close();
        if (e.exported === true) forgetRuns(); // the report card's list gets the new run
      }
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, take as EventListener);
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) setLink("reconnecting");
    };
    return () => source.close();
    // The pacing is read once: switching "reduce motion" mid-run keeps the clock going.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, run.events, clock, fromStart]);

  const timeline = useMemo(() => liveTimeline(state, reduced), [state, reduced]);
  const track = useMemo(() => liveTrack(timeline), [timeline]);

  // The paper stops once the run is over.
  useEffect(() => {
    if (state.finished) clock.stop(state.finished.at + 1500);
  }, [state.finished, clock]);

  // What's on screen. Recomputed every frame, but React only redraws when it changes.
  const [view, setView] = useState(() => viewAt(timeline, clock.now()));
  // A few times a second, so the status line, the countdown and the timer keep up with the clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    let key = "";
    let quarter = -1;
    return onFrame(() => {
      const t = clock.now();
      const v = viewAt(timeline, t);
      const k = viewKey(v);
      if (k !== key) {
        key = k;
        setView(v);
      }
      const q = Math.floor(t / 250);
      if (q !== quarter) {
        quarter = q;
        setTick(q);
      }
    });
  }, [timeline, clock]);

  // The stamp lands: a thud (if sound is on) and a shake (unless motion is reduced).
  const [slam, setSlam] = useState(0);
  const last = useRef({ trap: -1, stamped: false });
  useEffect(() => {
    const was = last.current;
    last.current = { trap: view.trap, stamped: view.stamped };
    if (!view.stamped || (was.trap === view.trap && was.stamped)) return;
    const plan = timeline.traps[view.trap];
    if (!plan || plan.stampAt === null || clock.now() - plan.stampAt > 450) return;
    sound.thud();
    setSlam((n) => n + 1);
  }, [view.trap, view.stamped, timeline, clock, sound]);

  // For the screenshot script and for checking things by hand in the browser console.
  useEffect(() => {
    window.polygraph = { ready: true, live: true, reduced, state: () => state, now: () => clock.now(), sound: { enabled: () => sound.enabled, contextCreated: () => sound.contextCreated } };
    return () => {
      window.polygraph = undefined;
    };
  }, [state, clock, sound, reduced]);

  const info = state.info;
  const plan = timeline.traps[view.trap];
  const botName = info ? info.bot.name ?? info.bot.model : run.name ?? run.model;
  const total = info?.traps.length ?? 0;
  // The screen can be a few seconds behind the server (each verdict stays up a
  // moment), so the end shows when the screen gets there.
  const finished = state.finished && clock.now() >= state.finished.at ? state.finished : null;
  const status = statusLine(state, clock.now(), view.trap);

  // Short announcements for screen readers: the question, then the verdict.
  const announcement = useMemo(() => {
    if (finished) return `The interrogation is over: ${finishedWords(finished.status)}.`;
    if (!plan) return "";
    const head = `Question ${plan.index + 1} of ${total}, ${plan.label}.`;
    if (!view.verdictShown || !plan.verdict) return head;
    const info = VERDICT_INFO[plan.verdict];
    return `${head} Verdict: ${info.word.toLowerCase()}${info.caught ? ", caught" : ""}.`;
  }, [plan, view.verdictShown, total, finished]);

  const toggleSound = () => {
    if (sound.enabled) sound.disable();
    else sound.enable();
    setSoundOn(sound.enabled);
  };
  const stop = () => {
    setStopAsked(true);
    stopRun(run.id).catch(() => setStopAsked(false));
  };

  return (
    <MotionConfig reducedMotion="user">
      <div
        data-motion={reduced ? "reduced" : "full"}
        className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 pt-3 pb-6 sm:px-6 lg:h-dvh lg:min-h-[720px] lg:px-8 lg:pt-[18px] lg:pb-[20px]"
      >
        <TopBar active="live">
          <div className="flex gap-2">
            {!state.finished && (
              <button
                type="button"
                onClick={stop}
                disabled={stopAsked || state.stopping}
                className="inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-[4px] border border-lie/60 bg-lie/10 px-0 font-label text-[14px] text-text transition-colors hover:bg-lie/20 disabled:opacity-60 sm:h-[38px] sm:w-[118px] sm:px-3.5"
              >
                <Icon name="stop" className="h-[16px] w-[16px]" />
                <span className="sr-only sm:not-sr-only">{stopAsked || state.stopping ? "Stopping" : "Stop"}</span>
              </button>
            )}
            <button
              type="button"
              onClick={toggleSound}
              aria-pressed={soundOn}
              className={`inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-[4px] border border-text/25 bg-white/[0.03] px-0 font-label text-[14px] transition-colors hover:bg-white/[0.08] sm:h-[38px] sm:w-[128px] sm:px-3.5 ${soundOn ? "text-text" : "text-muted"}`}
            >
              <Icon name={soundOn ? "sound-on" : "sound-off"} className="h-[18px] w-[18px]" />
              <span className="sr-only sm:not-sr-only">{soundOn ? "Sound on" : "Sound off"}</span>
            </button>
          </div>
        </TopBar>

        <LiveBar state={state} run={run} over={!!finished} />
        <LiveProgress state={state} timelineShown={view.shown} current={finished ? -1 : view.trap} now={clock.now()} status={status} link={link} />

        {state.errors.map((problem, i) => (
          <section key={i} role="alert" className="rounded-[4px] border border-lie/50 bg-lie/10 px-4 py-3 text-[15px] text-soft">
            <div className="font-label text-[13px] tracking-[0.14em] text-lie">{problem.title.toUpperCase()}</div>
            <p className="mt-1 mb-0">{problem.message}</p>
            {problem.hint && <p className="mt-1 mb-0 text-muted">{problem.hint}</p>}
          </section>
        ))}

        {finished && <FinishedPanel state={state} botName={botName} />}

        {plan ? (
          <main className="screen-grid mt-1">
            <div className="area-chart">
              <ChartPaper timeline={timeline} track={track} playback={clock} sound={sound} reduced={reduced} trapIndex={view.trap} stamped={view.stamped} slam={slam} />
            </div>
            <p className="area-note m-0 text-[13px] text-muted italic">{NEEDLE_NOTE}</p>
            <Transcript plan={plan} view={view} model={botName} reduced={reduced} confidenceQuestion={info?.confidence_question} />
            <div className="folder">
              <CaseSummary plan={plan} view={view} notJudged={!!finished && !plan.verdict} />
              <CaseDetails plan={plan} view={view} notJudged={!!finished && !plan.verdict} />
            </div>
          </main>
        ) : (
          !finished && <StatePanel kicker="LIVE" title={status || "Getting the interrogation ready…"} live="polite" />
        )}
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
      </div>
    </MotionConfig>
  );
}

function finishedWords(status: string): string {
  return status === "finished" ? "finished" : status === "cancelled" ? "stopped" : status === "stopped" ? "stopped early" : "it failed";
}

/** Which bot, run how, judged by whom. */
function LiveBar({ state, run, over }: { state: LiveState; run: RunSummary; over: boolean }) {
  const info = state.info;
  const bot = info?.bot;
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] text-[#d8cdb8] sm:text-[14px]">
      <span className="inline-flex items-center gap-1.5 rounded-[2px] bg-lie px-2 pt-[3px] pb-[2px] font-label text-[12px] tracking-[0.12em] text-room">
        <span className={`h-[7px] w-[7px] rounded-full bg-room ${over ? "" : "live-dot"}`} aria-hidden="true" />
        {over ? "LIVE · OVER" : "LIVE"}
      </span>
      <span>
        Subject: <b className="font-bold text-[#f3e8d2]">{bot?.name ?? bot?.model ?? run.name ?? run.model}</b>{" "}
        {bot && (
          <span className="text-muted">
            ({bot.name ? `built on ${bot.model}, ` : ""}made by {bot.maker}
            <span className="hidden sm:inline">, run with {bot.provider_label}</span>)
          </span>
        )}
      </span>
      {info && (
        <>
          <span className="hidden text-[#6f6556] md:inline" aria-hidden="true">·</span>
          <span className="hidden md:inline">
            Judge: {info.judge.model} ({info.judge.maker}), {info.judge.votes} votes each
          </span>
        </>
      )}
      {info?.pretend && <span className="rounded-[2px] border border-brass/60 px-1.5 text-[12px] text-brass">PRETEND: replaying a recorded run</span>}
    </div>
  );
}

const STRIP: Record<Verdict, string> = {
  HONEST: "border-honest text-honest",
  LIE: "border-lie text-lie bg-lie/10",
  CAVED: "border-caved text-caved bg-caved/10",
  CONTRADICTED: "border-contradicted text-contradicted bg-contradicted/10",
  DODGED: "border-dodged text-dodged",
};

/** Every trap in the run as a small box that fills in with its verdict, then where the run is. */
function LiveProgress({
  state, timelineShown, current, now, status, link,
}: { state: LiveState; timelineShown: (Verdict | null | undefined)[]; current: number; now: number; status: string; link: "open" | "reconnecting" }) {
  const info = state.info;
  const traps = info?.traps ?? [];
  const many = traps.length > 12;
  const counts = tally(state, now);
  // Once it's over, the run's own length (the screen may have joined late).
  const over = state.finished && now >= state.finished.at ? state.finished.duration_seconds : null;
  const elapsed = over !== null ? over * 1000 : state.startedAt === null ? 0 : Math.max(0, now - state.startedAt);
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  const started = state.traps.length;
  const cur = state.traps[current];
  return (
    <nav aria-label="Questions in this run" className="flex flex-col gap-2">
      <ol className={`m-0 flex list-none flex-wrap p-0 ${many ? "gap-1" : "gap-1.5 sm:gap-2"}`}>
        {traps.map((t, i) => {
          const v = timelineShown[i];
          const vinfo = v ? VERDICT_INFO[v] : null;
          const isNow = i === current;
          const words = `Question ${i + 1}: ${t.label}. ${vinfo ? `Verdict: ${vinfo.word.toLowerCase()}.` : i < started ? "Under way." : "Not asked yet."}`;
          return (
            <li
              key={t.trap}
              title={words}
              className={`inline-flex items-center justify-center rounded-[3px] border font-label ${
                many ? "h-[22px] min-w-[22px] px-[3px] text-[11px]" : "h-[30px] w-[46px] gap-1 text-[13px]"
              } ${vinfo && v ? STRIP[v] : "border-text/20 text-[#8c8272]"} ${isNow ? "outline-2 outline-offset-1 outline-text/40" : ""}`}
            >
              <span className="sr-only">{words}</span>
              <span aria-hidden="true" className="inline-flex items-center gap-1">
                {vinfo ? <Icon name={vinfo.icon} className={many ? "h-3 w-3" : "h-3.5 w-3.5"} strokeWidth={2.8} /> : many ? <span className="opacity-0">·</span> : null}
                {!many && i + 1}
              </span>
            </li>
          );
        })}
      </ol>
      {/* Fixed heights, so nothing below them moves as they change while answers
          stream in: one row each on a laptop; on a phone, where the run is on one
          row and the counts on the next, and the status line gets two. */}
      <div className="flex h-[44px] flex-col justify-center gap-1 text-[13px] leading-5 text-[#d8cdb8] sm:h-5 sm:flex-row sm:items-center sm:justify-start sm:gap-3">
        <span className="truncate">{cur ? `Question ${cur.index + 1} of ${traps.length} · ${cur.label}` : info ? `${traps.length} questions` : ""}</span>
        {info && (
          <span className="flex min-w-0 gap-3 overflow-hidden whitespace-nowrap text-muted">
            {Object.keys(counts).length > 0 && (
              <span>
                {(Object.keys(counts) as Verdict[]).map((v, k) => (
                  <span key={v}>
                    {k > 0 && " · "}
                    {VERDICT_INFO[v].glyph} {counts[v]}
                  </span>
                ))}
              </span>
            )}
            <span>
              {minutes}:{String(seconds).padStart(2, "0")} · {state.spent > 0 || !info.bot.local ? usd(state.spent) : "free"}
              <span className="hidden sm:inline">{state.spent > 0 && over === null ? " so far" : ""}</span>
            </span>
            {link === "reconnecting" && !state.finished && <span className="text-caved">Reconnecting…</span>}
          </span>
        )}
      </div>
      <p className="m-0 line-clamp-2 h-[42px] text-[14px] leading-[21px] text-brass sm:line-clamp-1 sm:h-[21px]">{status}</p>
    </nav>
  );
}

/** How the run ended, with the scores and where to see everything. */
function FinishedPanel({ state, botName }: { state: LiveState; botName: string }) {
  const f = state.finished!;
  const s = f.scores;
  const covered = s ? Object.keys(s.by_type).length : 0;
  const title =
    f.status === "finished" ? `The interrogation of ${botName} is over` : f.status === "cancelled" ? "The run was stopped" : f.status === "stopped" ? "The run stopped early" : "The run couldn't finish";
  const caught = s ? (s.verdicts.LIE ?? 0) + (s.verdicts.CAVED ?? 0) + (s.verdicts.CONTRADICTED ?? 0) : 0;
  return (
    <section aria-labelledby="live-over" className="manila rounded-[4px] px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <div className="font-label text-[12px] tracking-[0.16em] text-manila-label">CASE CLOSED</div>
          <h2 id="live-over" className="mt-1 mb-0 font-type text-[20px] leading-snug font-bold">{title}</h2>
          {f.stop_reason && f.status !== "finished" && <p className="mt-1 mb-0 text-[14px]">{f.stop_reason}</p>}
          {s && s.judged > 0 && (
            <p className="mt-1 mb-0 text-[14px]">
              Caught on {caught} of {s.judged} traps judged{covered < 8 ? `, across ${covered} of the 8 trap types` : ""}.{" "}
              {f.spent_usd > 0 ? `It cost ${usd(f.spent_usd)}.` : "It cost nothing."}
            </p>
          )}
        </div>
        {s && s.overall !== null && (
          <div className="flex items-end gap-4">
            <div>
              <div className="font-label text-[11px] tracking-[0.16em] text-manila-label">
                TRUTH SCORE{covered < 8 ? ` · ${covered} TYPE${covered === 1 ? "" : "S"}` : ""}
              </div>
              <div className="font-display text-[54px] leading-[0.9] font-bold">
                {shownScore(s.overall)}
                <span className="ml-1 text-[18px] text-manila-label">± {shownScore(s.margin_of_error)}</span>
              </div>
            </div>
            <div className="stamp-ink rotate-[-8deg] px-3 pt-0.5 pb-1 text-[52px] leading-[0.9]" aria-label={`Grade ${s.grade}`}>
              {s.grade}
            </div>
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2.5">
        {f.exported && f.run_id ? (
          <>
            <a href={hrefFor("report", { run: f.run_id })} className="inline-flex h-11 items-center rounded-[3px] bg-manila-ink px-4 font-label text-[14px] tracking-[0.04em] text-[#f3e8d2] no-underline hover:bg-black">
              Report card →
            </a>
            <a href={hrefFor("evidence", { run: f.run_id })} className="inline-flex h-11 items-center rounded-[3px] border border-manila-ink/60 px-4 font-label text-[14px] text-manila-ink no-underline hover:bg-black/5">
              Evidence wall
            </a>
            <a href={hrefFor("confidence", { run: f.run_id })} className="inline-flex h-11 items-center rounded-[3px] border border-manila-ink/60 px-4 font-label text-[14px] text-manila-ink no-underline hover:bg-black/5">
              Overconfidence
            </a>
          </>
        ) : (
          <p className="m-0 self-center text-[14px] text-manila-label">
            {f.pretend
              ? "A pretend run replays a recorded run, so nothing was saved."
              : f.judged_file
                ? "Saved. To see it on the report card, stop the dashboard (Ctrl+C) and run .\\start.ps1 again."
                : f.run_file
                  ? "The answers were saved, but nothing was judged, so there's no report card for this run."
                  : "Nothing was saved."}
          </p>
        )}
        <a href={hrefFor("new")} className="inline-flex h-11 items-center rounded-[3px] border border-manila-ink/60 px-4 font-label text-[14px] text-manila-ink no-underline hover:bg-black/5">
          New interrogation
        </a>
      </div>
      {f.judged_file && !f.pretend && (
        <p className="mt-2 mb-0 text-[12px] break-words text-manila-label">Saved in the runs folder: {f.run_file} and its judged copy, {f.judged_file}.</p>
      )}
    </section>
  );
}
