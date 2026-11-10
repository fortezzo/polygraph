import type { ReactNode } from "react";
import type { Status } from "../lib/playback";
import type { Timeline, View } from "../lib/timeline";
import type { Verdict } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { Icon, type IconName } from "./Icon";

function ControlButton({ icon, children, onClick, pressed, dim, wide }: { icon: IconName; children: ReactNode; onClick: () => void; pressed?: boolean; dim?: boolean; wide?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-[4px] border border-text/25 bg-white/[0.03] px-0 font-label text-[14px] transition-colors hover:bg-white/[0.08] sm:h-[38px] sm:px-3.5 ${wide ?? ""} ${dim ? "text-muted" : "text-text"}`}
    >
      <Icon name={icon} className="h-[18px] w-[18px]" />
      <span className="sr-only sm:not-sr-only">{children}</span>
    </button>
  );
}

export function Header(props: {
  status: Status;
  soundOn: boolean;
  onPlayPause: () => void;
  onRestart: () => void;
  onSound: () => void;
}) {
  const { status } = props;
  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-baseline gap-3.5">
        <h1 className="m-0 font-display text-[20px] font-semibold tracking-[0.22em] text-[#f3e8d2] sm:text-[24px] sm:tracking-[0.24em]">POLYGRAPH</h1>
        <span className="hidden font-label text-[13px] tracking-[0.06em] text-muted sm:inline">INTERROGATION ROOM</span>
      </div>
      <div className="flex gap-2">
        {/* Fixed widths, so changing labels never nudge the buttons next to them. */}
        <ControlButton icon={status === "playing" ? "pause" : status === "ended" ? "restart" : "play"} onClick={props.onPlayPause} wide="sm:w-[146px]">
          {status === "playing" ? "Pause" : status === "ended" ? "Play again" : "Play"}
        </ControlButton>
        <ControlButton icon="restart" onClick={props.onRestart}>Restart</ControlButton>
        <ControlButton icon={props.soundOn ? "sound-on" : "sound-off"} onClick={props.onSound} pressed={props.soundOn} dim={!props.soundOn} wide="sm:w-[128px]">
          {props.soundOn ? "Sound on" : "Sound off"}
        </ControlButton>
      </div>
    </header>
  );
}

export function ReplayBar({ model, maker, via, recorded, judge }: { model: string; maker?: string; via: string; recorded: string | null; judge?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] text-[#d8cdb8] sm:text-[14px]">
      <span className="inline-flex items-center gap-1.5 rounded-[2px] bg-brass px-2 pt-[3px] pb-[2px] font-label text-[12px] tracking-[0.12em] text-room">
        <Icon name="play" className="h-[11px] w-[11px]" strokeWidth={2.6} />
        REPLAY
      </span>
      <span>
        Subject: <b className="font-bold text-[#f3e8d2]">{model}</b>{" "}
        <span className="text-muted">
          ({maker ? `made by ${maker}` : ""}
          <span className="hidden sm:inline">{maker ? ", " : ""}run with {via}</span>)
        </span>
      </span>
      {recorded && (
        <>
          <span className="hidden text-[#6f6556] sm:inline" aria-hidden="true">·</span>
          <span>
            Recorded <b className="font-bold text-[#f3e8d2]">{recorded}</b>
          </span>
        </>
      )}
      {judge && (
        <>
          <span className="hidden text-[#6f6556] md:inline" aria-hidden="true">·</span>
          <span className="hidden md:inline">Judge: {judge}</span>
        </>
      )}
    </div>
  );
}

const RAIL: Record<Verdict, string> = {
  HONEST: "border-honest text-honest",
  LIE: "border-lie text-lie bg-lie/10",
  CAVED: "border-caved text-caved bg-caved/10",
  CONTRADICTED: "border-contradicted text-contradicted bg-contradicted/10",
  DODGED: "border-dodged text-dodged",
};

export function Rail({ timeline, view, onJump }: { timeline: Timeline; view: View; onJump: (i: number) => void }) {
  const cur = timeline.traps[view.trap];
  const tally = (Object.keys(VERDICT_INFO) as Verdict[])
    .map((v) => ({ v, n: view.shown.filter((s) => s === v).length }))
    .filter((x) => x.n > 0);
  return (
    <nav aria-label="Questions in this replay" className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-2">
      <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0 sm:gap-2">
        {timeline.traps.map((p, i) => {
          const v = view.shown[i];
          const info = v ? VERDICT_INFO[v] : null;
          const now = i === view.trap && !view.ended;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onJump(i)}
                aria-current={now ? "step" : undefined}
                aria-label={`Question ${i + 1}: ${p.label}. ${info ? `Verdict: ${info.word.toLowerCase()}.` : "Not shown yet."} Jump here.`}
                className={`inline-flex h-11 w-11 items-center justify-center gap-1 rounded-[3px] border font-label text-[13px] sm:h-[30px] sm:w-[46px] ${info && v ? RAIL[v] : "border-text/20 text-[#8c8272]"} ${now ? "outline-2 outline-offset-2 outline-text/30" : ""}`}
              >
                {info && <Icon name={info.icon} className="h-3.5 w-3.5" strokeWidth={2.6} />}
                {i + 1}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="m-0 text-[13px] text-[#d8cdb8]">
        {view.ended ? (
          <>
            Replay over.
            {/* On a phone the tally would wrap and push the page down; the boxes already show it. */}
            <span className="hidden sm:inline">
              {" "}
              {tally.map((x, k) => (
                <span key={x.v}>
                  {k > 0 && " · "}
                  {VERDICT_INFO[x.v].glyph} {x.n} {x.v === "LIE" && x.n !== 1 ? "lies" : VERDICT_INFO[x.v].word.toLowerCase()}
                </span>
              ))}
            </span>
          </>
        ) : cur ? (
          <>
            Question {cur.index + 1} of {timeline.traps.length} · {cur.label}
          </>
        ) : null}
      </p>
    </nav>
  );
}
