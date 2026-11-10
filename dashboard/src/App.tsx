import { useEffect, useMemo, useState } from "react";
import sample from "./sample/sample-run.json";
import { readRun } from "./data/runFile";
import { Room } from "./components/Room";
import { Empty, ErrorState, Loading } from "./components/States";
import { InterrogationScreen, type StartOptions } from "./screens/InterrogationScreen";

// The faces the replay uses. Nothing plays until they're ready, so text never
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

/** ?state=loading|empty|error shows those screens; ?paused, ?at=<trap id or ms>, ?rate=2 control the replay. */
function readParams() {
  const q = new URLSearchParams(window.location.search);
  const start: StartOptions = {
    paused: q.has("paused"),
    at: q.get("at"),
    rate: Number(q.get("rate")) > 0 ? Number(q.get("rate")) : 1,
  };
  return { state: q.get("state"), start };
}

export default function App() {
  const fontsReady = useFontsReady();
  const [{ state, start }, setParams] = useState(readParams);
  const result = useMemo(() => {
    if (state === "empty") return readRun({ ...sample, traps: [] });
    if (state === "error") return readRun({ format: "a-spreadsheet", note: "not a run file" });
    return readRun(sample);
  }, [state]);

  let body;
  if (state === "loading" || !fontsReady) body = <Loading />;
  else if (!result.ok) {
    body = (
      <ErrorState
        title={result.title}
        detail={result.detail}
        onRetry={() => {
          window.history.replaceState(null, "", window.location.pathname);
          setParams(readParams());
        }}
      />
    );
  } else if (result.run.traps.length === 0) body = <Empty />;
  else body = <InterrogationScreen run={result.run} start={start} />;

  return <Room>{body}</Room>;
}
