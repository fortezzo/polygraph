import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { SPEEDS, type Status } from "../lib/playback";
import type { Timeline, TrapPlan, View } from "../lib/timeline";
import type { Verdict } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { typeGroups, widestGroup } from "../lib/rail";
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

/** The replay's buttons: Play/Pause, Restart and Sound. They sit in the top bar. */
export function ReplayControls(props: {
  status: Status;
  soundOn: boolean;
  onPlayPause: () => void;
  onRestart: () => void;
  onSound: () => void;
}) {
  const { status } = props;
  return (
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
  );
}

/**
 * The replay's speed (Session 10): 1×, 2×, 4× or 8×. A whole 200-question
 * recording takes about an hour at 1× and about 8 minutes at 8×.
 */
export function SpeedControl({ rate, onRate }: { rate: number; onRate: (rate: number) => void }) {
  return (
    <div role="group" aria-label="Replay speed" className="inline-flex items-center gap-2">
      <span className="hidden font-label text-[13px] tracking-[0.1em] text-muted sm:inline" aria-hidden="true">
        SPEED
      </span>
      <div className="inline-flex overflow-hidden rounded-[4px] border border-text/25">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onRate(s)}
            aria-pressed={rate === s}
            aria-label={`Play at ${s} times speed`}
            className={`h-11 w-11 border-l border-text/25 font-label text-[14px] transition-colors first:border-l-0 sm:h-[34px] sm:w-[42px] ${
              rate === s ? "bg-brass text-room" : "bg-white/[0.03] text-text hover:bg-white/[0.08]"
            }`}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}

/** Jumps to just before the next made-up words (Session 10, Christian), so nobody has to wait for a lie. */
export function NextCaughtButton({ onNext, disabled }: { onNext: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onNext}
      disabled={disabled}
      title={disabled ? "No caught answers after this point" : "Jump to just before the next made-up words"}
      className="inline-flex h-11 items-center gap-2 rounded-[4px] border border-lie/60 bg-lie/[0.08] px-3.5 font-label text-[14px] text-text transition-colors hover:bg-lie/[0.16] disabled:cursor-not-allowed disabled:border-text/20 disabled:bg-transparent disabled:text-muted sm:h-[34px]"
    >
      <Icon name="next" className="h-[16px] w-[16px]" strokeWidth={2.4} />
      Next caught<span className="hidden sm:inline"> answer</span>
    </button>
  );
}

/** Which bot, when it was recorded, who judged it. "REPLAY" on the replay, "CASE FILE" elsewhere. */
export function ReplayBar({
  model, maker, via, recorded, judge, tag = "replay", subject,
}: {
  model: string;
  maker?: string | null;
  via: string;
  recorded: string | null;
  judge?: string;
  tag?: "replay" | "case";
  /** The replay's Recording picker (Session 10), in place of the bot's name. */
  subject?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] text-[#d8cdb8] sm:text-[14px]">
      <span className="inline-flex items-center gap-1.5 rounded-[2px] bg-brass px-2 pt-[3px] pb-[2px] font-label text-[12px] tracking-[0.12em] text-room">
        <Icon name={tag === "replay" ? "play" : "document"} className="h-[11px] w-[11px]" strokeWidth={2.6} />
        {tag === "replay" ? "REPLAY" : "CASE FILE"}
      </span>
      {subject}
      <span>
        {!subject && (
          <>
            Subject: <b className="font-bold text-[#f3e8d2]">{model}</b>{" "}
          </>
        )}
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

/** The Highlights' value in the Recording picker. */
export const HIGHLIGHTS = "highlights";

/**
 * The replay's Recording picker (Session 10): the Highlights, or a whole
 * interrogation. Each recording is only loaded when it's picked.
 */
export function RecordingPicker({
  value, highlights, options, note, onPick,
}: { value: string; highlights: string; options: { id: string; label: string }[]; note: string | null; onPick: (id: string) => void }) {
  return (
    <label className="inline-flex min-w-0 max-w-full items-center gap-2">
      <span className="sr-only font-label text-[13px] tracking-[0.08em] text-muted sm:not-sr-only">Recording</span>
      <select
        value={value}
        onChange={(e) => onPick(e.target.value)}
        className="h-11 min-w-0 max-w-[calc(100vw-8.5rem)] rounded-[4px] border border-text/25 bg-[#17130f] px-2.5 font-type text-[14px] text-text sm:h-[34px] sm:max-w-[470px]"
      >
        <option value={HIGHLIGHTS}>{highlights}</option>
        {options.length > 0 && (
          <optgroup label="Whole interrogations, every question">
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </optgroup>
        )}
        {note && (
          <option disabled value="">
            {note}
          </option>
        )}
      </select>
    </label>
  );
}

/** The tally of verdicts shown so far, for the end of a replay. */
function Tally({ view }: { view: View }) {
  const tally = (Object.keys(VERDICT_INFO) as Verdict[])
    .map((v) => ({ v, n: view.shown.filter((s) => s === v).length }))
    .filter((x) => x.n > 0);
  return (
    <>
      {tally.map((x, k) => (
        <span key={x.v}>
          {k > 0 && " · "}
          {VERDICT_INFO[x.v].glyph} {x.n} {x.v === "LIE" && x.n !== 1 ? "lies" : VERDICT_INFO[x.v].word.toLowerCase()}
        </span>
      ))}
    </>
  );
}

/**
 * The strip for a whole interrogation (Session 10): the 8 trap types as tabs,
 * and the current type's questions as boxes. It follows the replay; a tab jumps
 * to that type's first question, a box to its question. It keeps room for the
 * largest type, so nothing below it moves when the type changes.
 */
export function TypeRail({ timeline, view, onJump, aside }: { timeline: Timeline; view: View; onJump: (i: number) => void; aside?: ReactNode }) {
  const groups = useMemo(() => typeGroups(timeline), [timeline]);
  const room = widestGroup(groups);
  const cur: TrapPlan | undefined = timeline.traps[view.trap];
  const group = groups.find((g) => g.key === cur?.result.type) ?? groups[0];
  const tabs = useRef<HTMLUListElement>(null);
  // On a phone the tabs scroll sideways: keep the current type in view.
  useLayoutEffect(() => {
    const ul = tabs.current;
    const el = ul?.querySelector<HTMLElement>("[aria-current=true]");
    if (!ul || !el) return;
    const left = el.offsetLeft - 8;
    const right = el.offsetLeft + el.offsetWidth + 8;
    if (left < ul.scrollLeft) ul.scrollLeft = left;
    else if (right > ul.scrollLeft + ul.clientWidth) ul.scrollLeft = right - ul.clientWidth;
  }, [group?.key]);
  if (!group) return null;
  const k = cur ? group.traps.indexOf(cur) : -1;
  return (
    <nav aria-label="Questions in this recording" className="flex min-w-0 flex-col gap-2">
      <ul ref={tabs} className="m-0 flex list-none gap-1 overflow-x-auto p-0 [scrollbar-width:none]">
        {groups.map((g) => (
          <li key={g.key} className="shrink-0">
            <button
              type="button"
              onClick={() => onJump(g.traps[0]!.index)}
              aria-current={g === group ? "true" : undefined}
              // The name starts with the tab's own words ("Numbers"), then the type's full name.
              aria-label={`${g.short === g.label ? g.label : `${g.short}: ${g.label}`}, ${g.traps.length} questions. Jump to the first one.`}
              className={`inline-flex h-9 items-center whitespace-nowrap rounded-[3px] border px-2.5 font-label text-[13px] tracking-[0.04em] transition-colors sm:h-[30px] ${
                g === group ? "border-brass bg-brass/[0.12] text-[#f3e8d2]" : "border-text/20 text-muted hover:text-text"
              }`}
            >
              {g.short}
            </button>
          </li>
        ))}
      </ul>
      <ol className="m-0 flex list-none flex-wrap gap-[3px] p-0 sm:gap-1">
        {group.traps.map((p, n) => {
          const v = view.shown[p.index];
          const info = v ? VERDICT_INFO[v] : null;
          const now = p === cur && !view.ended;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onJump(p.index)}
                aria-current={now ? "step" : undefined}
                // The name starts with what the box shows (its number within the type), then where it is in the whole run.
                aria-label={`${group.short} ${n + 1}: question ${p.index + 1} of ${timeline.traps.length}, ${p.id}. ${info ? `Verdict: ${info.word.toLowerCase()}.` : "Not shown yet."} Jump here.`}
                className={`inline-flex h-6 w-6 items-center justify-center gap-1 rounded-[3px] border font-label text-[11px] sm:h-[30px] sm:w-[40px] sm:text-[12px] ${
                  info && v ? RAIL[v] : "border-text/20 text-[#8c8272]"
                } ${now ? "outline-2 outline-offset-1 outline-text/40" : ""}`}
              >
                {info && <Icon name={info.icon} className="h-3 w-3" strokeWidth={2.8} />}
                {/* On a phone a box shows the icon once there's a verdict, or else the number. */}
                <span className={info ? "hidden sm:inline" : undefined}>{n + 1}</span>
              </button>
            </li>
          );
        })}
        {Array.from({ length: room - group.traps.length }, (_, n) => (
          <li key={`room-${n}`} aria-hidden="true" className="invisible h-6 w-6 sm:h-[30px] sm:w-[40px]" />
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="m-0 h-5 min-w-0 flex-1 basis-[240px] truncate text-[13px] leading-5 text-[#d8cdb8]">
          {view.ended ? (
            <>
              Replay over. <Tally view={view} />
            </>
          ) : cur ? (
            <>
              Question {cur.index + 1} of {timeline.traps.length} · {group.label}, {k + 1} of {group.traps.length}
            </>
          ) : null}
        </p>
        {aside}
      </div>
    </nav>
  );
}

export function Rail({ timeline, view, onJump, aside }: { timeline: Timeline; view: View; onJump: (i: number) => void; aside?: ReactNode }) {
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
      {/* Session 10: the speed and Next caught answer, at the far end on a laptop. */}
      {aside && <div className="sm:ml-auto">{aside}</div>}
    </nav>
  );
}
