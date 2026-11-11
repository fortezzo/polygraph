import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import sample from "./sample/sample-run.json";
import { readRun } from "./data/runFile";
import { hrefFor, useRoute, type Route, type Screen } from "./lib/route";
import { recordingDisplay, recordingLabel, useRecordings, useRunFile } from "./lib/runs";
import { modelName } from "./lib/models";
import { DEMO } from "./lib/demo";
import { focusContent, Room } from "./components/Room";
import { Empty, ErrorState, Loading, StatePanel } from "./components/States";
import { HIGHLIGHTS, Picker, SubjectBar } from "./components/Header";
import { TopBar } from "./components/TopBar";
import { InterrogationScreen, type StartOptions } from "./screens/InterrogationScreen";
import { DataScreen } from "./screens/DataScreen";
import { ReportScreen } from "./screens/ReportScreen";
import { EvidenceScreen } from "./screens/EvidenceScreen";
import { ConfidenceScreen } from "./screens/ConfidenceScreen";
import { NewRunScreen } from "./screens/NewRunScreen";
import { LiveScreen } from "./screens/LiveScreen";
import { LineupScreen } from "./screens/LineupScreen";

// The faces the dashboard uses. Nothing shows until they're ready, so text never
// changes shape (and nothing jumps) when a font arrives late. Session 11: bold
// italic isn't waited for: it's rare, and Courier Prime's letters are all the same
// width, so it can arrive late without moving anything.
const FONTS = [
  '16px "Courier Prime"',
  'bold 16px "Courier Prime"',
  'italic 16px "Courier Prime"',
  '16px "Special Elite"',
  '600 16px "Oswald"',
  '700 16px "Oswald"',
];

function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        setReady(true);
      }
    };
    Promise.all(FONTS.map((f) => document.fonts.load(f))).then(finish, finish);
    const timer = window.setTimeout(finish, 3000); // never wait forever
    return () => window.clearTimeout(timer);
  }, []);
  return ready;
}

/**
 * Before the "#": ?state=loading|empty|error shows those screens, and the replay
 * takes ?paused, ?at=<trap id or ms> and ?rate=2. After the "#": which screen.
 */
function readParams() {
  const q = new URLSearchParams(window.location.search);
  const start: StartOptions = {
    paused: q.has("paused"),
    at: q.get("at"),
    rate: Number(q.get("rate")) > 0 ? Number(q.get("rate")) : 1,
  };
  return { state: q.get("state"), start };
}

/** The replay's frame while a recording loads, or can't be played: the menu and the picker stay. */
function ReplayFrame({ picker, children }: { picker: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 pt-3 pb-12 sm:px-6 lg:px-8 lg:pt-[18px]">
      <TopBar active="replay" />
      <SubjectBar tag="replay" picker={picker} />
      <main id="content">{children}</main>
    </div>
  );
}

/**
 * The interrogation room (Sessions 6 and 10): the Highlights, or a whole
 * recorded interrogation picked from the list. The list is a few KB; a
 * recording (up to about 1 MB) is only loaded when it's picked.
 */
function Replay({ route, state, start, sampleRun, onRetrySample, rate, onRate }: {
  route: Route;
  state: string | null;
  start: StartOptions;
  sampleRun: ReturnType<typeof readRun>;
  onRetrySample: () => void;
  rate: number;
  onRate: (rate: number) => void;
}) {
  const wanted = route.params.get("run") ?? HIGHLIGHTS;
  const [list, retryList] = useRecordings();
  const recordings = list.status === "ready" ? list.data : [];
  const rec = wanted === HIGHLIGHTS ? undefined : recordings.find((r) => r.id === wanted);
  const [file, retryFile] = useRunFile(rec);
  const pick = (id: string) => {
    window.location.hash = hrefFor("replay", id === HIGHLIGHTS ? {} : { run: id });
  };
  // Session 11: the picker shows the bot's friendly name, with its exact tag in small print.
  const sampleTag = sampleRun.ok ? sampleRun.run.run.target.model : null;
  const sampleCount = sampleRun.ok ? sampleRun.run.traps.length : 0;
  const highlights = sampleTag ? `Highlights: ${modelName(sampleTag)}, ${sampleCount} answers checked by hand` : "Highlights";
  const shown =
    rec ? recordingDisplay(rec)
    : wanted === HIGHLIGHTS ? { main: sampleTag ? `Highlights · ${modelName(sampleTag)}` : "Highlights", sub: sampleTag ? `${sampleCount} answers checked by hand · ${sampleTag}` : "" }
    : { main: "Pick a recording", sub: "" };
  const picker = (
    <Picker
      label="Recording"
      value={rec ? rec.id : wanted === HIGHLIGHTS ? HIGHLIGHTS : ""}
      options={[
        { id: HIGHLIGHTS, label: highlights },
        ...recordings.map((r) => ({ id: r.id, label: recordingLabel(r), group: "Whole interrogations, every question" })),
      ]}
      main={shown.main}
      sub={shown.sub || null}
      note={list.status === "loading" ? "Loading the other recordings…" : list.status === "error" ? "The other recordings couldn't be loaded" : null}
      onPick={pick}
    />
  );

  if (wanted === HIGHLIGHTS) {
    if (state === "loading") return <Loading />;
    if (!sampleRun.ok) return <ErrorState title={sampleRun.title} detail={sampleRun.detail} onRetry={onRetrySample} />;
    if (sampleRun.run.traps.length === 0) return <Empty />;
    return <InterrogationScreen key={HIGHLIGHTS} run={sampleRun.run} start={start} rate={rate} onRate={onRate} picker={picker} />;
  }
  if (list.status === "loading" || (rec && file.status === "loading")) {
    return (
      <ReplayFrame picker={picker}>
        <StatePanel kicker="LOADING" title="Bringing in the subject…" live="polite">
          <p className="m-0">Loading the recording of the whole interrogation.</p>
        </StatePanel>
      </ReplayFrame>
    );
  }
  if (list.status === "error") {
    return (
      <ReplayFrame picker={picker}>
        <StatePanel kicker="SOMETHING WENT WRONG" title={list.title} live="assertive" onRetry={retryList}>
          <p className="m-0">{list.detail}</p>
        </StatePanel>
      </ReplayFrame>
    );
  }
  if (!rec) {
    return (
      <ReplayFrame picker={picker}>
        <StatePanel kicker="NOT FOUND" title="That recording isn't here">
          <p className="m-0">
            It may have been replaced by a newer run. Pick another recording above, or{" "}
            <a href={hrefFor("replay")} className="text-brass underline underline-offset-2">
              watch the Highlights
            </a>
            .
          </p>
        </StatePanel>
      </ReplayFrame>
    );
  }
  if (file.status === "error") {
    return (
      <ReplayFrame picker={picker}>
        <StatePanel kicker="SOMETHING WENT WRONG" title={file.title} live="assertive" onRetry={retryFile}>
          <p className="m-0">{file.detail}</p>
        </StatePanel>
      </ReplayFrame>
    );
  }
  if (file.status !== "ready") return null;
  return <InterrogationScreen key={rec.id} run={file.data} start={start} rate={rate} onRate={onRate} picker={picker} />;
}

/** The public demo (Session 10) has no live mode. Its address explains why, instead of a dead end. */
function NotInDemo() {
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 pt-3 pb-12 sm:px-6 lg:px-8 lg:pt-[18px]">
      <TopBar active="new" />
      <main id="content">
        <StatePanel kicker="NOT IN THIS DEMO" title="New interrogations run on the computer where Polygraph is installed">
          <p className="m-0">
            This site replays interrogations that were recorded earlier. Starting a new one needs Polygraph&rsquo;s server and the API keys
            of the companies whose bots it asks, so it only runs on that computer.
          </p>
          <p className="mt-3 mb-0">
            <a href={hrefFor("replay")} className="inline-flex min-h-11 items-center text-brass underline underline-offset-2">
              Watch a recorded interrogation
            </a>
          </p>
        </StatePanel>
      </main>
    </div>
  );
}

const TITLES: Record<Screen, string> = {
  replay: "Interrogation room",
  report: "Report card",
  evidence: "Evidence wall",
  confidence: "Overconfidence meter",
  lineup: "The lineup",
  new: "New interrogation",
  live: "Live interrogation",
};

export default function App() {
  const fontsReady = useFontsReady();
  const route = useRoute();
  const [{ state, start }, setParams] = useState(readParams);
  // The replay's speed (Session 10). It stays when another recording is picked.
  const [rate, setRate] = useState(start.rate ?? 1);

  // A new screen starts at the top, with its own page title.
  // Session 11: after the first screen, a new screen also takes the keyboard's focus
  // to its main heading, so a screen reader says where you are and Tab starts there.
  const firstScreen = useRef(true);
  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = `Polygraph · ${TITLES[route.screen]}`;
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    const t = window.setTimeout(() => focusContent(true), 0);
    return () => window.clearTimeout(t);
  }, [route.screen]);

  const sampleRun = useMemo(() => {
    if (state === "empty") return readRun({ ...sample, traps: [] });
    if (state === "error") return readRun({ format: "a-spreadsheet", note: "not a run file" });
    return readRun(sample);
  }, [state]);

  let body;
  if (!fontsReady) body = <Loading plain />;
  else if (route.screen === "replay") {
    body = (
      <Replay
        route={route}
        state={state}
        start={start}
        sampleRun={sampleRun}
        onRetrySample={() => {
          window.history.replaceState(null, "", window.location.pathname + window.location.hash);
          setParams(readParams());
        }}
        rate={rate}
        onRate={setRate}
      />
    );
  } else if (route.screen === "new" || route.screen === "live") {
    // Live mode needs Polygraph's server, which the public demo doesn't have.
    body = DEMO ? <NotInDemo /> : route.screen === "new" ? <NewRunScreen /> : <LiveScreen route={route} />;
  } else if (route.screen === "lineup") {
    body = <LineupScreen route={route} forced={state} />;
  } else {
    body = (
      <DataScreen route={route} forced={state}>
        {(run, entry) =>
          route.screen === "report" ? (
            <ReportScreen run={run} entry={entry} />
          ) : route.screen === "evidence" ? (
            <EvidenceScreen run={run} entry={entry} route={route} />
          ) : (
            <ConfidenceScreen run={run} entry={entry} route={route} />
          )
        }
      </DataScreen>
    );
  }

  return <Room>{body}</Room>;
}
