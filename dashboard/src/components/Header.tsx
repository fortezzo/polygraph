import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { SPEEDS, type Status } from "../lib/playback";
import type { Timeline, TrapPlan, View } from "../lib/timeline";
import type { Verdict } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { typeGroups, widestGroup } from "../lib/rail";
import { Icon, type IconName } from "./Icon";

// Session 11: the buttons show their words from 1280 px wide. Narrower, they show
// just their icons (their words stay for screen readers, and as a tooltip), so the
// menu next to them always fits.
export const CONTROL =
  "inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-[4px] border bg-white/[0.03] px-0 font-label text-[14px] transition-colors sm:h-[38px] min-[1280px]:px-3.5";
export const CONTROL_WORDS = "sr-only min-[1280px]:not-sr-only";

function ControlButton({ icon, children, onClick, pressed, dim, wide, title }: { icon: IconName; children: string; onClick: () => void; pressed?: boolean; dim?: boolean; wide?: string; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      title={title ?? children}
      className={`${CONTROL} ${pressed ? "border-brass/80" : "border-text/25"} hover:bg-white/[0.08] ${wide ?? ""} ${dim ? "text-muted" : "text-text"}`}
    >
      <Icon name={icon} className="h-[18px] w-[18px]" />
      <span className={CONTROL_WORDS}>{children}</span>
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
        <ControlButton icon={status === "playing" ? "pause" : status === "ended" ? "restart" : "play"} onClick={props.onPlayPause} wide="min-[1280px]:w-[146px]">
          {status === "playing" ? "Pause" : status === "ended" ? "Play again" : "Play"}
        </ControlButton>
        <ControlButton icon="restart" onClick={props.onRestart}>Restart</ControlButton>
        {/* Session 11: a toggle keeps one name, "Sound", and says on or off by being
            pressed or not (and by its icon and outline), so a screen reader hears its
            state once. */}
        <ControlButton
          icon={props.soundOn ? "sound-on" : "sound-off"}
          onClick={props.onSound}
          pressed={props.soundOn}
          dim={!props.soundOn}
          wide="min-[1280px]:w-[112px]"
          title={props.soundOn ? "Sound is on" : "Sound is off"}
        >
          Sound
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
      <div className="inline-flex rounded-[4px] border border-text/25">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onRate(s)}
            aria-pressed={rate === s}
            aria-label={`Play at ${s} times speed`}
            className={`h-11 w-11 border-l border-text/25 font-label text-[14px] transition-colors first:rounded-l-[3px] first:border-l-0 last:rounded-r-[3px] sm:h-[34px] sm:w-[42px] ${
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

/**
 * Session 11: a picker that never cuts a name short. A real <select> does the
 * picking (the phone's own list, the keyboard, screen readers), laid invisibly
 * over a two-line label: the name, then the exact model tag and what the
 * recording is, in small print. The select's text is 16 px, so an iPhone doesn't
 * zoom in when it's tapped.
 */
export interface PickerOption {
  id: string;
  label: string;
  group?: string | null;
}

/**
 * Session 12 (Christian): the open list is drawn by the browser, not the page. On
 * Windows, Chrome and Edge draw it as a small white page of their own, with the
 * select's background under the options and each option in its own colors. The
 * options inherited the invisible select's see-through text, so the list was blank
 * white, apart from the browser's highlight on the option under the mouse. Now each
 * option and group heading has its own colors, on the dark of the picker's box: the
 * page's text for a choice, brass for a heading, the small print's color for a line
 * that can't be picked. The select gets that dark too, as the list's background.
 * Closed, it stays invisible: opacity 0, and see-through text.
 * src/components/dropdowns.test.ts checks these colors in a real browser.
 */
const LIST = "bg-[#17130f]";
const LIST_OPTION = `${LIST} text-text`;
const LIST_GROUP = `${LIST} text-brass`;
const LIST_NOTE = `${LIST} text-muted`;

export function Picker({
  label, value, options, main, sub, note, onPick,
}: {
  /** What it picks, for screen readers: "Recording" or "Subject". */
  label: string;
  value: string;
  options: PickerOption[];
  main: string;
  sub?: ReactNode;
  /** A last line in the list that can't be picked, like "Loading the other recordings…". */
  note?: string | null;
  onPick: (id: string) => void;
}) {
  // Options with the same group sit together under its heading, in order.
  const groups: { group: string | null; options: PickerOption[] }[] = [];
  for (const o of options) {
    const g = o.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.group === g) last.options.push(o);
    else groups.push({ group: g, options: [o] });
  }
  return (
    <label className="relative flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[4px] border border-text/25 bg-[#17130f] py-1.5 pr-2 pl-3 text-text transition-colors hover:bg-[#1f1a14] has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-offset-3 has-[select:focus-visible]:outline-brass sm:max-w-[520px] sm:flex-none">
      <span className="sr-only">{label}</span>
      <span className="flex min-w-0 flex-1 flex-col" aria-hidden="true">
        <span className="font-type text-[15px] leading-[20px] font-bold [overflow-wrap:anywhere] text-[#f3e8d2]">{main}</span>
        {sub && <span className="font-type text-[12px] leading-[16px] [overflow-wrap:anywhere] text-muted">{sub}</span>}
      </span>
      <Icon name="chevron-down" className="h-4 w-4 shrink-0 text-muted" strokeWidth={2.4} />
      <select
        value={value}
        onChange={(e) => onPick(e.target.value)}
        className={`absolute inset-0 h-full w-full cursor-pointer appearance-none ${LIST} text-[16px] text-transparent opacity-0`}
      >
        {groups.map((g, i) =>
          g.group ? (
            <optgroup key={`${g.group}-${i}`} label={g.group} className={LIST_GROUP}>
              {g.options.map((o) => (
                <option key={o.id} value={o.id} className={LIST_OPTION}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : (
            g.options.map((o) => (
              <option key={o.id} value={o.id} className={LIST_OPTION}>
                {o.label}
              </option>
            ))
          ),
        )}
        {note && (
          <option disabled value="" className={LIST_NOTE}>
            {note}
          </option>
        )}
      </select>
    </label>
  );
}

/**
 * The subject bar, under the menu on every screen with a bot (Session 11): the
 * REPLAY or CASE FILE tag, the picker, then who made the bot, how it ran, when
 * it was recorded and who judged it. The details are spaced apart, with no dots
 * between them, so a wrapped line never ends on a stray dot. On a phone the tag
 * and the "run with" and judge details step aside, to give the picker the room.
 */
export function SubjectBar({
  tag, picker, maker, via, recorded, judge,
}: {
  tag: "replay" | "case";
  picker: ReactNode;
  maker?: string | null;
  via?: string | null;
  recorded?: string | null;
  judge?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="hidden shrink-0 items-center gap-1.5 rounded-[2px] bg-brass px-2 pt-[3px] pb-[2px] font-label text-[12px] tracking-[0.12em] text-room sm:inline-flex">
          <Icon name={tag === "replay" ? "play" : "document"} className="h-[11px] w-[11px]" strokeWidth={2.6} />
          {tag === "replay" ? "REPLAY" : "CASE FILE"}
        </span>
        {picker}
      </div>
      <p className="m-0 flex min-h-5 flex-wrap gap-x-4 gap-y-0.5 text-[13px] leading-5 text-muted sm:text-[13.5px]">
        {maker && (
          <span>
            Made by <span className="text-[#d8cdb8]">{maker}</span>
          </span>
        )}
        {via && (
          <span className="hidden sm:inline">
            Run with <span className="text-[#d8cdb8]">{via}</span>
          </span>
        )}
        {recorded && (
          <span>
            Recorded <span className="text-[#d8cdb8]">{recorded}</span>
          </span>
        )}
        {judge && (
          <span className="hidden md:inline">
            Judge <span className="text-[#d8cdb8]">{judge}</span>
          </span>
        )}
      </p>
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
 * Session 11: a strip of buttons is one stop for the Tab key (the current one), and
 * the arrow keys, Home and End move between its buttons. A whole recording's strip
 * used to be 33 Tab stops (8 trap types and 25 questions) before the rest of the page.
 */
function arrowKeys(e: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  e.preventDefault();
  const to =
    e.key === "Home" ? 0
    : e.key === "End" ? buttons.length - 1
    : e.key === "ArrowRight" || e.key === "ArrowDown" ? Math.min(buttons.length - 1, at + 1)
    : Math.max(0, at - 1);
  buttons[to]?.focus();
}

/** The Tab stop in a strip: the current button, or the first when none is current. */
const stop = (isCurrent: boolean, isFirst: boolean, anyCurrent: boolean) => (isCurrent || (!anyCurrent && isFirst) ? 0 : -1);

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
      <ul ref={tabs} className="-mx-1.5 -my-1.5 flex list-none gap-1 overflow-x-auto px-1.5 py-1.5 [scrollbar-width:none]" onKeyDown={arrowKeys} aria-label="Trap types: use the arrow keys">
        {groups.map((g, gi) => (
          <li key={g.key} className="shrink-0">
            <button
              type="button"
              onClick={() => onJump(g.traps[0]!.index)}
              tabIndex={stop(g === group, gi === 0, true)}
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
      <ol className="m-0 flex list-none flex-wrap gap-[3px] p-0 sm:gap-1" onKeyDown={arrowKeys} aria-label={`${group.label}: use the arrow keys`}>
        {group.traps.map((p, n) => {
          const v = view.shown[p.index];
          const info = v ? VERDICT_INFO[v] : null;
          const now = p === cur && !view.ended;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onJump(p.index)}
                tabIndex={stop(now, n === 0, group.traps.some((x) => x === cur) && !view.ended)}
                aria-current={now ? "step" : undefined}
                // The name starts with what the box shows (its number within the type), then where it is in the whole run.
                aria-label={`${group.short} ${n + 1}: question ${p.index + 1} of ${timeline.traps.length}, ${p.id}. ${info ? `Verdict: ${info.word.toLowerCase()}.` : "Not shown yet."} Jump here.`}
                className={`inline-flex h-6 w-6 items-center justify-center gap-1 rounded-[3px] border font-label text-[11px] sm:h-[30px] sm:w-[40px] sm:text-[12px] ${
                  info && v ? RAIL[v] : "border-text/20 text-[#8c8272]"
                } ${now ? "shadow-[0_0_0_2px_#0c0a08,0_0_0_4px_rgba(239,230,213,0.4)]" : ""}`}
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
      {/* Session 11: the line gets room for its longest words before the buttons
          join it, so it isn't cut short on a tablet. A phone leaves out "4 of 25":
          the box that's lit up says it. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="m-0 h-5 min-w-0 flex-1 basis-[350px] truncate text-[13px] leading-5 text-[#d8cdb8]">
          {view.ended ? (
            <>
              Replay over. <Tally view={view} />
            </>
          ) : cur ? (
            <>
              Question {cur.index + 1} of {timeline.traps.length} · {group.label}
              <span className="hidden min-[400px]:inline">, {k + 1} of {group.traps.length}</span>
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
      <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0 sm:gap-2" onKeyDown={arrowKeys} aria-label="Questions: use the arrow keys">
        {timeline.traps.map((p, i) => {
          const v = view.shown[i];
          const info = v ? VERDICT_INFO[v] : null;
          const now = i === view.trap && !view.ended;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onJump(i)}
                tabIndex={stop(now, i === 0, !view.ended)}
                aria-current={now ? "step" : undefined}
                aria-label={`Question ${i + 1}: ${p.label}. ${info ? `Verdict: ${info.word.toLowerCase()}.` : "Not shown yet."} Jump here.`}
                className={`inline-flex h-11 w-11 items-center justify-center gap-1 rounded-[3px] border font-label text-[13px] sm:h-[30px] sm:w-[46px] ${info && v ? RAIL[v] : "border-text/20 text-[#8c8272]"} ${now ? "shadow-[0_0_0_2px_#0c0a08,0_0_0_4px_rgba(239,230,213,0.3)]" : ""}`}
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
