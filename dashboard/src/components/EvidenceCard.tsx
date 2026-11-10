import type { ReactNode } from "react";
import type { CheckedReference, RunFile, TrapResult } from "../data/runFile";
import { answersOf } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { phraseIn } from "../lib/phrase";
import { parseAnswer, plainText } from "../lib/markdown";
import { namesToHide } from "../lib/names";
import { confidenceFor, formatNumber, votesFor } from "../lib/report";
import type { Tone } from "../lib/timeline";
import { NameSafe } from "./NameSafe";
import { RichAnswer } from "./RichAnswer";
import { VerdictBadge } from "./VerdictBadge";

const Key = ({ children }: { children: ReactNode }) => (
  <div className="mb-0.5 font-label text-[11px] tracking-[0.16em] text-manila-label">{children}</div>
);

const REF_LABEL: Record<string, { glyph: string; cls: string }> = {
  "made up": { glyph: "✗", cls: "text-lie-ink" },
  "real paper, wrong details": { glyph: "≈", cls: "text-caved-ink" },
  "can't tell": { glyph: "?", cls: "text-manila-label" },
};

function References({ refs }: { refs: CheckedReference[] }) {
  return (
    <div className="mt-3 rounded-[3px] border border-dashed border-manila-label/40 px-3 py-2.5">
      <Key>THE REFERENCES IT GAVE · CHECKED AGAINST CROSSREF, NO AI</Key>
      <ol className="m-0 list-none space-y-2 p-0 text-[13px] leading-snug">
        {refs.map((r) => {
          const l = REF_LABEL[r.label] ?? { glyph: "·", cls: "text-manila-label" };
          const real = r.real_paper;
          return (
            <li key={r.number}>
              <span className={`font-label text-[12px] tracking-[0.06em] ${l.cls}`}>
                {l.glyph} {r.label.toUpperCase()}
              </span>
              {r.quote && (
                <div className="mt-0.5 text-manila-ink/90">
                  <NameSafe text={plainText(parseAnswer(r.quote))} />
                </div>
              )}
              {real && (
                <div className="mt-0.5 text-manila-label">
                  The real paper: &ldquo;{real.title}&rdquo;
                  {real.journal ? `, ${real.journal}` : ""}
                  {real.years?.length ? ` (${real.years[0]})` : ""}.
                  {r.wrong?.length ? ` Wrong in the answer: ${r.wrong.join(" and ")}.` : ""}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One caught answer (or an honest one, if the filters show those), as evidence. */
export function EvidenceCard({ run, trap }: { run: RunFile; trap: TrapResult }) {
  const v = trap.verdict;
  const info = v ? VERDICT_INFO[v] : null;
  const tone = info?.caught && v ? (v.toLowerCase() as Tone) : null;
  const answers = answersOf(trap);
  const phrase = tone ? phraseIn(answers, trap.made_up_phrase, trap.judgement?.phrase_answer) : null;
  const point = confidenceFor(run, trap.id);
  const votes = votesFor(trap);
  const doc = trap.trap.document ? run.documents?.[trap.trap.document] : undefined;
  const refs = trap.judgement?.hard_check?.details?.references ?? [];
  const j = trap.judgement;
  const hand = trap.hand_label;
  const handWord = hand ? VERDICT_INFO[hand.verdict].word.toLowerCase() : "";

  // Each answer, with its hot span and (in a caught answer) the names to hide.
  let n = 0;
  const blocks: ReactNode[] = [];
  const whole: ReactNode[] = [];
  let long = false;
  trap.conversations.forEach((conv, ci) => {
    conv.turns.forEach((turn, ti) => {
      const key = `${ci}-${ti}`;
      if (turn.role === "user") {
        const isPush = turn.kind === "push_back";
        const text = doc && turn.kind === "question" ? trap.trap.question : turn.content;
        const label = isPush ? "PUSHED BACK" : trap.conversations.length > 1 ? `CHAT ${ci + 1} · Q` : "Q";
        blocks.push(
          <div key={`q${key}`} className="mt-3">
            <Key>{label}</Key>
            <p className="m-0 text-[14.5px] leading-snug font-bold">{text}</p>
          </div>,
        );
        return;
      }
      n += 1;
      const hot = phrase && tone && phrase.answer === n ? { start: phrase.start, end: phrase.end, tone } : null;
      const hidden = tone ? namesToHide(turn.content) : [];
      if (turn.content.length > 700) long = true;
      const label = answers.length > 1 ? `A${n}` : "A";
      blocks.push(
        <div key={`a${key}`} className="mt-2">
          <Key>{label} · <span className="normal-case">{run.run.target.name ?? run.run.target.model}</span></Key>
          <RichAnswer text={turn.content} hot={hot} hidden={hidden} excerpt />
          {turn.call?.truncated && <CutOff />}
        </div>,
      );
      whole.push(
        <div key={`w${key}`} className="mt-2">
          <Key>{label}</Key>
          <RichAnswer text={turn.content} hot={hot} hidden={hidden} />
        </div>,
      );
    });
  });

  return (
    <article id={`card-${trap.id}`} className="card-paper relative min-w-0 rounded-[3px] px-4 pt-5 pb-4 [overflow-wrap:anywhere] sm:px-5" aria-label={`${trap.label}, ${trap.id}: ${info ? info.word.toLowerCase() : "not judged"}`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-label text-[11px] tracking-[0.14em] text-manila-label">
            {trap.label.toUpperCase()} · {trap.id}
          </div>
          <div className="mt-1.5">{v ? <VerdictBadge verdict={v} /> : <span className="text-manila-label">Not judged</span>}</div>
          <div className="mt-1 text-[12px] leading-snug text-manila-label">
            {votes.total > 1 && (votes.agree === votes.total ? `${votes.agree} of ${votes.total} judge votes` : `${votes.agree} of ${votes.total} judge votes: a split decision`)}
            {j?.decided_by === "hard_check" && "Decided by Polygraph's own check, no AI"}
          </div>
        </div>
        {point && point.confidence !== null && (
          <div className="shrink-0 text-right">
            <div className="font-display text-[32px] leading-none font-bold">{formatNumber(point.confidence)}%</div>
            <div className="mt-0.5 text-[11px] leading-snug text-manila-label">
              sure{point.reply !== null ? <> · said &ldquo;{point.reply.trim()}&rdquo;</> : null}
              {point.answer && /^average/.test(point.answer) && <><br />the {point.answer} answers</>}
              {point.answer && /^\d+$/.test(point.answer) && answers.length > 1 && <><br />after answer {point.answer}</>}
              {point.suspect && <><br />looks misread</>}
            </div>
          </div>
        )}
      </header>

      {doc && (
        <div className="mt-3 rounded-[2px] bg-black/5 px-3 py-2 text-[13px]">
          <span className="font-label text-[11px] tracking-[0.14em] text-manila-label">EXHIBIT · </span>
          {doc.title}
        </div>
      )}
      {blocks}
      {refs.length > 0 && <References refs={refs} />}
      {long && (
        <details className="mt-2 text-[13px]">
          <summary className="cursor-pointer font-label tracking-[0.06em] text-paper-ink">Show the whole answer{answers.length > 1 ? "s" : ""}</summary>
          {whole}
        </details>
      )}

      {trap.reason && info && (
        <div className="mt-3 border-t border-dashed border-manila-label/40 pt-3 text-[13.5px] leading-snug">
          <Key>{info.reasonHeading}</Key>
          <NameSafe text={trap.reason} />
          {j?.own_knowledge && <p className="mt-1 mb-0 text-[12.5px] text-manila-label">⚑ This rests on the judge&rsquo;s own knowledge, not the hand-checked truth. Worth checking.</p>}
          {j?.unsettled && <p className="mt-1 mb-0 text-[12.5px] text-manila-label">⚖ The judge&rsquo;s votes stayed tied, so the milder verdict is shown.</p>}
        </div>
      )}
      <div className="mt-3 text-[13.5px] leading-snug">
        <Key>THE TRUTH</Key>
        {trap.trap.truth}
        <div className="mt-1.5 text-[12.5px]">
          <span className="font-label tracking-[0.12em] text-manila-label">SOURCE </span>
          {trap.trap.source.url ? (
            <a className="text-manila-ink underline decoration-manila-label/60 underline-offset-2" href={trap.trap.source.url} target="_blank" rel="noreferrer">
              {trap.trap.source.title}
            </a>
          ) : (
            trap.trap.source.title
          )}
        </div>
      </div>
      {hand && v && (
        <p className={`mt-3 mb-0 rounded-[2px] px-2.5 py-1.5 text-[12.5px] leading-snug ${hand.verdict === v ? "bg-black/5" : "border border-lie-ink/50 bg-lie-ink/5"}`}>
          {hand.verdict === v ? (
            <>✓ Checked by hand: Christian also called it {handWord === "lie" ? "a lie" : handWord}.</>
          ) : (
            <>✋ Checked by hand: Christian called it {handWord === "lie" ? "a lie" : handWord}. Polygraph and he disagree on this one.</>
          )}
        </p>
      )}
    </article>
  );
}

/** Under an answer that hit the length limit (Christian, Session 9): it still counts, as it stands. */
function CutOff() {
  return (
    <p className="m-0 mt-1 text-[12px] leading-snug text-manila-label">
      <span className="font-label tracking-[0.12em]" aria-hidden="true">✂ </span>
      <span className="font-label tracking-[0.12em]">CUT OFF</span> · this answer hit the length limit. It was judged and scored as it stands.
    </p>
  );
}
