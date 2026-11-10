import { useEffect, useMemo, useState } from "react";
import sample from "./sample/sample-run.json";
import { readRun } from "./data/runFile";
import { useRoute, type Screen } from "./lib/route";
import { Room } from "./components/Room";
import { Empty, ErrorState, Loading } from "./components/States";
import { InterrogationScreen, type StartOptions } from "./screens/InterrogationScreen";
import { DataScreen } from "./screens/DataScreen";
import { ReportScreen } from "./screens/ReportScreen";
import { EvidenceScreen } from "./screens/EvidenceScreen";
import { ConfidenceScreen } from "./screens/ConfidenceScreen";
import { NewRunScreen } from "./screens/NewRunScreen";
import { LiveScreen } from "./screens/LiveScreen";
import { LineupScreen } from "./screens/LineupScreen";

// The faces the dashboard uses. Nothing shows until they're ready, so text never
// changes shape (and nothing jumps) when a font arrives late.
const FONTS = [
  '16px "Courier Prime"',
  'bold 16px "Courier Prime"',
  'italic 16px "Courier Prime"',
  'bold italic 16px "Courier Prime"',
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

  // A new screen starts at the top, with its own page title.
  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = `Polygraph · ${TITLES[route.screen]}`;
  }, [route.screen]);

  const sampleRun = useMemo(() => {
    if (state === "empty") return readRun({ ...sample, traps: [] });
    if (state === "error") return readRun({ format: "a-spreadsheet", note: "not a run file" });
    return readRun(sample);
  }, [state]);

  let body;
  if (!fontsReady) body = <Loading />;
  else if (route.screen === "replay") {
    if (state === "loading") body = <Loading />;
    else if (!sampleRun.ok) {
      body = (
        <ErrorState
          title={sampleRun.title}
          detail={sampleRun.detail}
          onRetry={() => {
            window.history.replaceState(null, "", window.location.pathname + window.location.hash);
            setParams(readParams());
          }}
        />
      );
    } else if (sampleRun.run.traps.length === 0) body = <Empty />;
    else body = <InterrogationScreen run={sampleRun.run} start={start} />;
  } else if (route.screen === "new") {
    body = <NewRunScreen />;
  } else if (route.screen === "live") {
    body = <LiveScreen route={route} />;
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
