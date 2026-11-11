import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { TrapPlan, TurnPlan, TurnView, View } from "../lib/timeline";
import { lastVisibleIn, parseAnswer, piecesOf, type Line } from "../lib/markdown";
import { NAME_HIDDEN } from "../lib/names";
import { onFrame } from "../lib/frame";
import { VERDICT_INFO } from "../data/verdicts";
import { Icon } from "./Icon";

// Every turn is laid out at full size from the start, with the part that hasn't
// streamed in yet invisible. Text appears in place, so nothing on the page moves
// while an answer streams in (PLAN.md section 8).

interface Props {
  plan: TrapPlan;
  view: View;
  model: string;
  reduced: boolean;
  confidenceQuestion?: string;
  /** A custom bot's own instructions (Session 10): shown with every question, since it got them every time. */
  instructions?: string | null;
}

const offsetIn = (el: HTMLElement, box: HTMLElement) =>
  el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;

export function Transcript({ plan, view, model, reduced, confidenceQuestion, instructions }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const target = useRef<number | null>(null);

  // A new question starts at the top, following along again.
  useLayoutEffect(() => {
    follow.current = true;
    target.current = null;
    lastSet.current = 0;
    if (box.current) box.current.scrollTop = 0;
  }, [plan.id]);

  // If the viewer scrolls the transcript themselves (wheel, touch, keys or the
  // scrollbar), stop following until the next question.
  const lastSet = useRef(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const stop = () => {
      follow.current = false;
      target.current = null;
    };
    // Any scroll the replay didn't make itself is the viewer's.
    const onScroll = () => {
      if (Math.abs(el.scrollTop - lastSet.current) > 3) stop();
    };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchmove", stop, { passive: true });
    el.addEventListener("keydown", stop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchmove", stop);
      el.removeEventListener("keydown", stop);
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Keep the newest words in view. Once the verdict is in, go back to the made-up words.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !follow.current) return;
    if (view.finalShown && plan.tone) {
      const hot = el.querySelector<HTMLElement>("[data-hot]");
      if (hot) {
        // Show as much of the lead-up as fits (the top, then the question or push-back,
        // then the answer's label) while the made-up words stay in the top 70%.
        const hotTop = offsetIn(hot, el);
        const h = el.clientHeight;
        const starts = [...el.querySelectorAll<HTMLElement>("[data-turn]")]
          .map((t) => offsetIn(t, el) - 8)
          .filter((o) => o <= hotTop);
        const candidates = [0, ...starts.slice(-2), hotTop - h * 0.25];
        target.current = candidates.find((c) => hotTop - c < h * 0.7) ?? hotTop - h * 0.25;
      }
      return;
    }
    // Live runs: a saved answer appears whole. Show it from its label, which says
    // it's saved, rather than jumping to its end (Christian, Session 8).
    const shown = [...el.querySelectorAll<HTMLElement>("[data-turn]")].filter((t) => !t.classList.contains("unseen"));
    const latest = shown[shown.length - 1];
    if (latest && latest.dataset.saved !== undefined) {
      const want = offsetIn(latest, el) - 8;
      if (Math.abs(want - el.scrollTop) > 2) target.current = want;
      return;
    }
    const marks = el.querySelectorAll<HTMLElement>("[data-follow]");
    const caret = el.querySelector<HTMLElement>("[data-caret]") ?? marks[marks.length - 1];
    if (!caret) return;
    const want = offsetIn(caret, el) - el.clientHeight * 0.72;
    if (want > el.scrollTop + 2) target.current = want;
  });

  useEffect(
    () =>
      onFrame(() => {
        const el = box.current;
        const goal = target.current;
        if (!el || goal === null) return;
        const to = Math.max(0, Math.min(goal, el.scrollHeight - el.clientHeight));
        const d = to - el.scrollTop;
        // Ease most of the way, then snap: a step smaller than a pixel could be
        // rounded away, and the scroll would never arrive (or let go).
        if (Math.abs(d) < 4 || reduced) {
          el.scrollTop = to;
          target.current = null;
        } else el.scrollTop += Math.sign(d) * Math.max(1, Math.abs(d) * 0.18);
        lastSet.current = el.scrollTop;
      }),
    [reduced],
  );

  return (
    <div
      ref={box}
      className="transcript-box area-transcript h-[23rem] overflow-y-auto pt-3 pr-2 pb-10 lg:h-auto lg:min-h-0"
      tabIndex={0}
      role="region"
      aria-label="Transcript of this question"
    >
      {instructions && (
        <div className="mb-4" data-turn="">
          <Label>ITS OWN INSTRUCTIONS · SENT BEFORE EVERY CONVERSATION</Label>
          <p className="m-0 text-[14px] leading-relaxed text-muted italic">&ldquo;{instructions}&rdquo;</p>
        </div>
      )}
      {plan.exhibit && <Exhibit title={plan.exhibit.title} text={plan.exhibit.text} shown={view.exhibitShown} />}
      {plan.turns.map((turn, i) => {
        const tv = view.turns[i];
        if (!tv) return null;
        return turn.role === "user" ? (
          <Question key={turn.key} turn={turn} tv={tv} />
        ) : (
          <Answer key={turn.key} turn={turn} tv={tv} model={model} stamped={view.stamped} confidenceQuestion={confidenceQuestion} />
        );
      })}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1 font-label text-[13px] tracking-[0.14em] text-brass">{children}</div>;
}

function Exhibit({ title, text, shown }: { title: string; text: string; shown: boolean }) {
  return (
    <div className={`mb-5 ${shown ? "" : "unseen"}`} data-turn="">
      <Label>EXHIBIT · POLYGRAPH HANDED OVER A DOCUMENT</Label>
      <div className="rounded-[3px] bg-paper px-4 py-3 text-[15px] text-manila-ink shadow-[0_8px_20px_rgba(0,0,0,0.4)]">
        <div className="flex items-start gap-2.5">
          <Icon name="document" className="mt-0.5 h-5 w-5 shrink-0 text-paper-ink" strokeWidth={2} />
          <span className="font-bold">{title}</span>
        </div>
        <details className="mt-2 text-[14px]">
          <summary className="cursor-pointer font-label text-[13px] tracking-[0.08em] text-paper-ink">Read the document</summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{text}</p>
        </details>
      </div>
      <p className="mt-2 text-[13px] text-muted">The bot got the document and the question together, with &ldquo;Please answer my question using only the information in this document.&rdquo;</p>
    </div>
  );
}

/** Plain text revealed word by word, with the caret at the reveal point. */
function Typed({ text, reveal, typing }: { text: string; reveal: number; typing: boolean }) {
  const pieces = piecesOf([{ text, start: 0, marks: [] }], reveal, null);
  let caretPlaced = !typing;
  return (
    <>
      {pieces.map((p) => {
        const caret = !caretPlaced && !p.shown;
        if (caret) caretPlaced = true;
        return (
          <Fragment key={p.start}>
            {caret && <span className="caret" data-caret="" />}
            <span className={p.shown ? undefined : "unseen"}>{p.text}</span>
          </Fragment>
        );
      })}
      {!caretPlaced && <span className="caret" data-caret="" />}
    </>
  );
}

// A turn only redraws when what it shows changes.
const sameTurn = (a: { tv: TurnView }, b: { tv: TurnView }) =>
  a.tv.started === b.tv.started && a.tv.reveal === b.tv.reveal && a.tv.typing === b.tv.typing && a.tv.confidenceShown === b.tv.confidenceShown;

const Question = memo(function Question({ turn, tv }: { turn: TurnPlan; tv: TurnView }) {
  const firstOfChat = turn.chat > 1 && turn.kind === "question";
  const label =
    turn.kind === "push_back"
      ? "Q · POLYGRAPH PUSHED BACK"
      : turn.chats > 1
        ? `CHAT ${turn.chat} OF ${turn.chats} · Q · POLYGRAPH ASKED`
        : "Q · POLYGRAPH ASKED";
  return (
    <div className={`mb-4 ${tv.started ? "" : "unseen"}`} data-turn="">
      {firstOfChat && (
        <div className="mb-4 flex items-center gap-3 text-[12px] tracking-[0.1em] text-muted">
          <span className="h-px flex-1 border-t border-dashed border-muted/50" />
          A NEW CHAT. IT CAN&rsquo;T SEE ITS OTHER ANSWERS.
          <span className="h-px flex-1 border-t border-dashed border-muted/50" />
        </div>
      )}
      <Label>{label}</Label>
      <p className="m-0 text-[17px] leading-[1.5] text-[#f6eedf] lg:text-[19px]">
        <Typed text={turn.text} reveal={tv.reveal} typing={tv.typing} />
      </p>
    </div>
  );
}, (a, b) => a.turn === b.turn && sameTurn(a, b));

const Answer = memo(function Answer({
  turn, tv, model, stamped, confidenceQuestion,
}: { turn: TurnPlan; tv: TurnView; model: string; stamped: boolean; confidenceQuestion?: string }) {
  const blocks = useMemo(() => parseAnswer(turn.text), [turn.text]);
  const hot = turn.hot;
  // The tag follows the piece holding the made-up phrase's last visible letter.
  // It's laid out from the start (hidden until the stamp lands), so it never moves text.
  const tagAt = useMemo(() => lastVisibleIn(blocks, hot), [blocks, hot]);
  // A live answer still being written has nothing unshown, so its caret goes at
  // the very end: the transcript follows it as the words arrive.
  const lastLine = blocks[blocks.length - 1]?.lines.at(-1);
  // Collect the rendering in one pass, so the caret lands at the first unshown character.
  let caretPlaced = !tv.typing;
  let hotMarked = false;
  const markers = new Set<number>();
  const renderLine = (line: Line) => [
    ...renderPieces(line),
    ...(line === lastLine && !caretPlaced ? [<span key="caret-end" className="caret" data-caret="" />] : []),
  ];
  const renderPieces = (line: Line) =>
    piecesOf(line, tv.reveal, hot, turn.hidden).map((p) => {
      const out: ReactNode[] = [];
      if (!caretPlaced && !p.shown) {
        caretPlaced = true;
        out.push(<span key={`c${p.start}`} className="caret" data-caret="" />);
      }
      if (p.hidden !== null) {
        // A hidden name: one marker in its place, the same size from the start.
        if (!markers.has(p.hidden)) {
          markers.add(p.hidden);
          out.push(
            <span
              key={p.start}
              className={`name-hidden ${p.shown ? "" : "unseen"} ${p.hot && p.shown && hot ? `hot-${hot.tone}` : ""}`}
              title="Polygraph hides people's names in studies and citations. A name stays only in a reference its own check found in Crossref, with those authors. The recording keeps the original."
            >
              {NAME_HIDDEN}
            </span>,
          );
        }
        if (hot && tagAt !== null && tagAt >= p.start && tagAt < p.start + p.text.length) {
          out.push(<CaughtTag key={`tag${p.start}`} tone={hot.tone} shown={stamped && p.shown} />);
        }
        return out;
      }
      const cls = [
        p.marks.includes("b") ? "font-bold" : "",
        p.marks.includes("i") ? "italic" : "",
        // Session 10: no padding or rounded corners on code. A streaming answer splits a
        // piece of code where the words stop, and padding on each part made the line
        // wrap and then unwrap (a jump, seen in whole recordings, which have code).
        p.marks.includes("code") ? "bg-white/8" : "",
        p.shown ? "" : "unseen",
        p.hot && p.shown && hot ? `hot-${hot.tone}` : "",
      ].filter(Boolean).join(" ");
      const firstHot = p.hot && !hotMarked;
      if (firstHot) hotMarked = true;
      out.push(
        <span key={p.start} className={cls || undefined} data-hot={firstHot ? "" : undefined}>
          {p.text}
        </span>,
      );
      if (hot && tagAt !== null && tagAt >= p.start && tagAt < p.start + p.text.length) {
        out.push(<CaughtTag key={`tag${p.start}`} tone={hot.tone} shown={stamped && p.shown} />);
      }
      return out;
    });

  return (
    <div className={`mb-5 ${tv.started ? "" : "unseen"}`} data-turn="" data-saved={turn.saved ? "" : undefined}>
      <Label>
        A · <span className="normal-case tracking-[0.06em]">{model}</span> ANSWERED
        {turn.saved && (
          // Live runs: an answer reused from an earlier run says so, instead of
          // streaming in as if the bot were writing it now (Christian, Session 8).
          <span
            className="ml-2 inline-block rounded-[2px] border border-brass/60 px-1.5 align-[1px] text-[11px] tracking-[0.12em] text-brass"
            title="Polygraph asked this exact question before, so it reused the bot's answer instead of asking again."
          >
            SAVED ANSWER FROM {turn.saved.toUpperCase()}
          </span>
        )}
      </Label>
      <div className="text-[15px] leading-[1.62] text-soft lg:text-[16px]">
        {blocks.map((b, bi) => {
          const firstStart = b.lines[0]?.[0]?.start ?? 0;
          if (b.kind === "li") {
            return (
              <div key={bi} className="mb-1.5 flex gap-2" style={{ paddingLeft: `${b.level * 1.2}rem` }}>
                <span className={`w-6 shrink-0 text-right ${tv.reveal > firstStart ? "" : "unseen"}`}>{b.bullet}</span>
                <span className="min-w-0 whitespace-pre-wrap">{renderLine(b.lines[0] ?? [])}</span>
              </div>
            );
          }
          const Tag = b.kind === "pre" ? "pre" : "p";
          return (
            <Tag key={bi} className={`mb-3 whitespace-pre-wrap ${b.kind === "h" ? "font-bold" : ""} ${b.kind === "pre" ? "overflow-x-auto rounded bg-white/5 p-2 text-[14px]" : ""}`}>
              {b.lines.map((l, li) => (
                <Fragment key={li}>
                  {li > 0 && <br />}
                  {renderLine(l)}
                </Fragment>
              ))}
            </Tag>
          );
        })}
        {turn.text.trim() === "" && (
          // Session 9: Gemma 4 thought until it hit the length limit on 3 traps, and never answered.
          <p className="mb-3 text-muted italic">{turn.cutOff ? "(No answer: it hit the length limit before writing one.)" : "(It gave no answer.)"}</p>
        )}
      </div>
      {turn.cutOff && turn.text.trim() !== "" && (
        <p className={`m-0 mb-1 text-[12px] leading-snug text-muted ${tv.started && tv.reveal >= turn.text.length ? "" : "unseen"}`}>
          <span className="font-label tracking-[0.12em]" aria-hidden="true">✂ </span>
          <span className="font-label tracking-[0.12em]">CUT OFF</span> · this answer hit the length limit. It was judged and scored as it stands.
        </p>
      )}
      {turn.confidence && (
        <p className={`mt-1 text-[13px] text-muted ${tv.confidenceShown ? "" : "unseen"}`} data-follow={tv.confidenceShown ? "" : undefined}>
          <span className="font-label tracking-[0.12em] text-brass" title={confidenceQuestion}>CONFIDENCE CHECK</span>{" "}
          · asked how sure it was (0 to 100), it replied &ldquo;{turn.confidence.reply?.trim() || "nothing"}&rdquo;
        </p>
      )}
    </div>
  );
}, (a, b) => a.turn === b.turn && a.model === b.model && a.stamped === b.stamped && sameTurn(a, b));

function CaughtTag({ tone, shown }: { tone: "lie" | "caved" | "contradicted"; shown: boolean }) {
  const info = VERDICT_INFO[tone === "lie" ? "LIE" : tone === "caved" ? "CAVED" : "CONTRADICTED"];
  const color = tone === "lie" ? "text-lie border-lie" : tone === "caved" ? "text-caved border-caved" : "text-contradicted border-contradicted";
  const words = tone === "lie" ? "MADE UP" : tone === "caved" ? "CAVED" : "CONTRADICTS";
  return (
    <span className={`ml-1.5 inline-flex items-center gap-1 rounded-[2px] border px-1.5 align-[2px] font-label text-[11px] leading-[18px] tracking-[0.1em] ${color} ${shown ? "" : "unseen"}`}>
      <Icon name={info.icon} className="h-2.5 w-2.5" strokeWidth={3.2} />
      {words}
    </span>
  );
}
