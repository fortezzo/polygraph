import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { MotionConfig, useReducedMotion } from "motion/react";
import type { RunFile } from "../data/runFile";
import { answersOf } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { buildTimeline, marksOf, nextCaught, viewAt, viewKey, type Timeline } from "../lib/timeline";
import { trackOf } from "../lib/signal";
import { Playback } from "../lib/playback";
import { Sound } from "../lib/sound";
import { onFrame } from "../lib/frame";
import { recordedRange } from "../lib/format";
import { MANY } from "../lib/rail";
import { subjectOf } from "../lib/runs";
import { ChartPaper } from "../components/ChartPaper";
import { Transcript } from "../components/Transcript";
import { CaseDetails, CaseSummary } from "../components/CaseNotes";
import { NextCaughtButton, ReplayControls, Rail, ReplayBar, SpeedControl, TypeRail } from "../components/Header";
import { TopBar } from "../components/TopBar";

export interface StartOptions {
  paused?: boolean;
  /** A trap id ("ghost-004") or a time in milliseconds. */
  at?: string | null;
  rate?: number;
}

const NEEDLE_NOTE =
  "The needle shows where Polygraph’s judge found made-up words, replayed in sync with the answer. It’s not a live signal.";

function startTime(tl: Timeline, at: string | null | undefined): number {
  if (!at) return 0;
  const trap = tl.traps.find((p) => p.id === at);
  if (trap) return trap.start;
  const ms = Number(at);
  return Number.isFinite(ms) ? ms : 0;
}

declare global {
  interface Window {
    polygraph?: unknown;
  }
}

export function InterrogationScreen({
  run, start = {}, rate = start.rate ?? 1, onRate, picker,
}: {
  run: RunFile;
  start?: StartOptions;
  /** Session 10: the speed, kept by the app so a newly picked recording plays at it too. */
  rate?: number;
  onRate?: (rate: number) => void;
  /** Session 10: the Recording picker, shown where the bot's name goes. */
  picker?: ReactNode;
}) {
  const reduced = useReducedMotion() ?? false;
  const timeline = useMemo(() => buildTimeline(run, { reduced }), [run, reduced]);
  const track = useMemo(() => trackOf(timeline), [timeline]);
  const playback = useMemo(
    () => new Playback(timeline.duration, { paused: start.paused, at: startTime(timeline, start.at), rate }),
    // Only a new timeline (the reduce-motion setting changed) gets a new clock.
    [timeline],
  );
  // A new speed carries on from exactly where the replay is.
  useEffect(() => playback.setRate(rate), [playback, rate]);
  // Whether there's a caught answer still ahead, for "Next caught answer".
  const [hasNext, setHasNext] = useState(() => nextCaught(timeline, playback.now()) !== null);
  const subscribe = useCallback((fn: () => void) => playback.subscribe(fn), [playback]);
  const status = useSyncExternalStore(subscribe, () => playback.status);
  const sound = useMemo(() => new Sound(), []);
  const [soundOn, setSoundOn] = useState(false);

  // What's on screen. Recomputed every frame, but React only redraws when it changes.
  const [view, setView] = useState(() => viewAt(timeline, playback.now()));
  useEffect(() => {
    let key = "";
    let next: boolean | null = null;
    return onFrame(() => {
      playback.tick();
      const t = playback.now();
      const v = viewAt(timeline, t);
      const k = viewKey(v);
      if (k !== key) {
        key = k;
        setView(v);
      }
      const ahead = nextCaught(timeline, t) !== null;
      if (ahead !== next) {
        next = ahead;
        setHasNext(ahead);
      }
    });
  }, [timeline, playback]);

  // The stamp lands: a thud (if sound is on) and a shake (unless motion is reduced).
  const [slam, setSlam] = useState(0);
  const last = useRef({ trap: -1, stamped: false });
  useEffect(() => {
    const was = last.current;
    last.current = { trap: view.trap, stamped: view.stamped };
    if (!view.stamped || (was.trap === view.trap && was.stamped)) return;
    const plan = timeline.traps[view.trap];
    if (playback.status !== "playing" || !plan || plan.stampAt === null) return;
    if (playback.now() - plan.stampAt > 450) return; // jumped here, didn't watch it land
    sound.thud();
    setSlam((n) => n + 1);
  }, [view.trap, view.stamped, timeline, playback, sound]);

  // Pause while the tab is hidden, and carry on when it's back.
  useEffect(() => {
    let resume = false;
    const onVisibility = () => {
      if (document.hidden) {
        resume = playback.status === "playing";
        playback.pause();
        sound.quiet();
      } else if (resume) {
        playback.play();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [playback, sound]);

  // For the screenshot script and for checking things by hand in the browser console.
  useEffect(() => {
    window.polygraph = {
      ready: true,
      reduced,
      duration: timeline.duration,
      marks: marksOf(timeline),
      now: () => playback.now(),
      status: () => playback.status,
      seek: (t: number) => playback.seek(t),
      pause: () => playback.pause(),
      play: () => playback.play(),
      rate: () => playback.rate,
      traps: timeline.traps.length,
      nextCaught: () => nextCaught(timeline, playback.now()),
      sound: { enabled: () => sound.enabled, contextCreated: () => sound.contextCreated },
    };
    return () => {
      window.polygraph = undefined;
    };
  }, [timeline, playback, sound, reduced]);

  // Short announcements for screen readers: the question, then the verdict.
  const plan = timeline.traps[view.trap];
  const announcement = useMemo(() => {
    if (!plan) return "";
    if (view.ended) return "The replay is over.";
    const head = `Question ${plan.index + 1} of ${timeline.traps.length}, ${plan.label}.`;
    if (!view.verdictShown || !plan.verdict) return head;
    const info = VERDICT_INFO[plan.verdict];
    const sure = view.finalShown && plan.headline ? ` It said it was ${plan.headline.value}% sure.` : "";
    return `${head} Verdict: ${info.word.toLowerCase()}${info.caught ? ", caught" : ""}.${sure}`;
  }, [plan, view.verdictShown, view.finalShown, view.ended, timeline.traps.length]);

  const recorded = useMemo(
    () => recordedRange(run.traps.flatMap((t) => answersOf(t).map((a) => a.call?.first_collected_at))) ?? recordedRange([run.run.started_at]),
    [run],
  );
  const target = run.run.target;
  const judge = run.run.judge;

  const toggleSound = () => {
    if (sound.enabled) sound.disable();
    else sound.enable();
    setSoundOn(sound.enabled);
  };
  const playPause = () => {
    if (playback.status === "playing") playback.pause();
    else if (playback.status === "ended") playback.restart();
    else playback.play();
  };
  const jump = (i: number) => {
    const p = timeline.traps[i];
    if (!p) return;
    playback.seek(p.start);
    playback.play();
  };
  // Session 10 (Christian): straight to the next lie, just before its made-up words stream in.
  const goNext = () => {
    const n = nextCaught(timeline, playback.now());
    if (!n) return;
    playback.seek(n.at);
    playback.play();
  };
  const instructions = target.system_prompt?.trim() || null;
  // Session 10: the speed and "Next caught answer", at the end of the strip of questions.
  const controls = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <SpeedControl rate={rate} onRate={(r) => onRate?.(r)} />
      <NextCaughtButton onNext={goNext} disabled={!hasNext} />
    </div>
  );

  return (
    <MotionConfig reducedMotion="user">
      <div
        data-motion={reduced ? "reduced" : "full"}
        className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 pt-3 pb-6 sm:px-6 lg:h-dvh lg:min-h-[720px] lg:px-8 lg:pt-[18px] lg:pb-[20px]"
      >
        <TopBar active="replay">
          <ReplayControls status={status} soundOn={soundOn} onPlayPause={playPause} onRestart={() => playback.restart()} onSound={toggleSound} />
        </TopBar>
        <ReplayBar
          model={subjectOf(target)}
          maker={judge?.bot_company}
          via={target.provider_label}
          recorded={recorded}
          judge={judge ? `${judge.model}${judge.company ? ` (${judge.company})` : ""}` : undefined}
          subject={picker}
        />
        {timeline.traps.length > MANY ? (
          <TypeRail timeline={timeline} view={view} onJump={jump} aside={controls} />
        ) : (
          <Rail timeline={timeline} view={view} onJump={jump} aside={controls} />
        )}
        {plan && (
          <main className="screen-grid mt-1">
            <div className="area-chart">
              <ChartPaper
                timeline={timeline}
                track={track}
                playback={playback}
                sound={sound}
                reduced={reduced}
                trapIndex={view.trap}
                stamped={view.stamped}
                slam={slam}
              />
            </div>
            <p className="area-note m-0 text-[13px] text-muted italic">{NEEDLE_NOTE}</p>
            <Transcript
              plan={plan}
              view={view}
              model={target.model}
              reduced={reduced}
              confidenceQuestion={run.run.prompts?.confidence_question}
              instructions={instructions}
            />
            <div className="folder">
              <CaseSummary plan={plan} view={view} />
              <CaseDetails plan={plan} view={view} />
            </div>
          </main>
        )}
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
      </div>
    </MotionConfig>
  );
}
