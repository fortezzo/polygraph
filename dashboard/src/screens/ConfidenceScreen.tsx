import type { ReactNode } from "react";
import type { RunFile } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { buckets, formatNumber, mostConfidentCheckedLie, shownScore } from "../lib/report";
import { parseAnswer, plainText } from "../lib/markdown";
import { hrefFor, replaceHash, type Route } from "../lib/route";
import type { RunEntry } from "../lib/runs";
import { CalibrationChart } from "../components/CalibrationChart";
import { EvidenceCard } from "../components/EvidenceCard";
import { NameSafe } from "../components/NameSafe";
import { StatePanel } from "../components/States";
import { VerdictBadge } from "../components/VerdictBadge";

const Kicker = ({ children }: { children: ReactNode }) => (
  <div className="mb-1 font-label text-[12px] tracking-[0.16em] text-muted">{children}</div>
);

/** The overconfidence meter: how sure the bot said it was, against how often it was honest. */
export function ConfidenceScreen({ run, entry, route }: { run: RunFile; entry: RunEntry; route: Route }) {
  const c = run.scores?.calibration;
  if (!c || !c.rated) {
    return (
      <StatePanel kicker="NOTHING TO MEASURE" title="This bot never gave a usable confidence number">
        <p className="m-0">After every answer Polygraph asks how sure the bot is, from 0 to 100. None of its replies had a clear number, so there&rsquo;s nothing to chart.</p>
      </StatePanel>
    );
  }
  const clean = route.params.get("readings") === "clean" && c.suspect > 0;
  const s = clean ? c.without_suspect : c;
  const bs = clean ? buckets(c.points, true) : c.buckets;
  const over = s.overconfidence ?? 0;
  const checked = mostConfidentCheckedLie(run);
  const byId = new Map(run.traps.map((t) => [t.id, t]));
  const setClean = (on: boolean) => replaceHash(hrefFor("confidence", { run: entry.id, readings: on ? "clean" : null }));

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-12">
      <section aria-labelledby="meter-title" className="min-w-0">
        <h1 id="meter-title" className="sr-only">Overconfidence meter</h1>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <Kicker>IT SAID IT WAS</Kicker>
            <div className="font-display text-[64px] leading-[0.9] font-bold text-[#f3e8d2] sm:text-[84px]">{shownScore(s.mean_confidence)}%</div>
            <div className="mt-1 text-[14px] text-soft">sure, on average</div>
          </div>
          <div>
            <Kicker>IT WAS HONEST</Kicker>
            <div className="font-display text-[64px] leading-[0.9] font-bold text-[#f3e8d2] sm:text-[84px]">{shownScore(s.honest_rate)}%</div>
            <div className="mt-1 text-[14px] text-soft">of the time</div>
          </div>
        </div>
        <p className="mt-5 mb-0 font-display text-[28px] leading-tight font-bold tracking-[0.02em] sm:text-[34px]">
          {over >= 5 ? (
            <span className="text-lie">{shownScore(over)} points overconfident</span>
          ) : over <= -5 ? (
            <span className="text-dodged">{shownScore(-over)} points underconfident</span>
          ) : (
            <span className="text-honest">About right, on average</span>
          )}
        </p>
        <p className="mt-2 mb-0 text-[15px] leading-relaxed text-soft">
          Caught <b className="text-text">{s.confident_and_caught}</b> {s.confident_and_caught === 1 ? "time" : "times"} while saying it was at least 80% sure.
          {s.mean_confidence_honest !== null && s.mean_confidence_caught !== null && (
            <> When it was honest it said {shownScore(s.mean_confidence_honest)}% on average; when it was caught, {shownScore(s.mean_confidence_caught)}%.</>
          )}
        </p>

        {c.suspect > 0 && (
          <div className="mt-5 rounded-[4px] border border-text/20 bg-white/[0.03] px-4 py-3 text-[14px] leading-relaxed text-soft">
            <p className="m-0">
              <b className="text-text">{c.suspect} of its {c.rated} readings look misread.</b>{" "}
              {c.suspect_zero ? `${c.suspect_zero} times it said 0 ("I'm sure my answer is wrong") right after answering` : ""}
              {c.suspect_zero && c.suspect_echo ? ", and " : ""}
              {c.suspect_echo ? `${c.suspect_echo === 1 ? "once" : `${c.suspect_echo} times`} it repeated a number from its own answer` : ""}. Polygraph keeps them and flags them.
            </p>
            <button
              type="button"
              aria-pressed={clean}
              onClick={() => setClean(!clean)}
              className={`mt-3 inline-flex h-11 items-center gap-2 rounded-[4px] border px-3 font-label text-[13px] sm:h-9 ${clean ? "border-brass bg-brass text-room" : "border-text/30 text-text hover:bg-white/[0.06]"}`}
            >
              <span aria-hidden="true">{clean ? "☑" : "☐"}</span> Leave them out
            </button>
          </div>
        )}

        <div className="chart-panel mt-6 rounded-[3px] px-3 pt-4 pb-3 sm:px-5">
          <CalibrationChart buckets={bs} />
          <p className="m-0 mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-manila-ink">
            <span><span className="mr-1.5 inline-block h-3 w-3 align-[-1px] border border-honest-ink bg-[rgba(22,79,45,0.62)]" aria-hidden="true" />Bar: how often it was honest</span>
            <span><span className="mr-1.5 inline-block h-[3px] w-4 align-[3px] bg-lie-ink" aria-hidden="true" />Line: how sure it said it was</span>
            <span><span className="mr-1.5 inline-block h-3 w-3 align-[-1px] bg-[repeating-linear-gradient(45deg,rgba(138,23,15,0.45)_0_2px,transparent_2px_5px)]" aria-hidden="true" />The gap: overconfidence</span>
            <span><span className="mr-1.5 inline-block w-4 align-[3px] border-t-[1.5px] border-dashed border-paper-ink" aria-hidden="true" />Dashed: perfectly calibrated</span>
          </p>
        </div>
        <table className="mt-4 w-full border-collapse text-[14px] text-soft">
          <caption className="mb-1 text-left font-label text-[12px] tracking-[0.16em] text-muted">THE SAME NUMBERS</caption>
          <thead>
            <tr className="border-b border-text/20 text-left text-[12.5px] text-muted">
              <th scope="col" className="py-1.5 pr-3 font-normal">Said it was</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-normal">Answers</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-normal">Average it said</th>
              <th scope="col" className="py-1.5 text-right font-normal">Honest</th>
            </tr>
          </thead>
          <tbody>
            {bs.map((b) => (
              <tr key={b.low} className="border-b border-text/10">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal">{b.low}–{b.high}%</th>
                <td className="py-1.5 pr-3 text-right">{b.answers}</td>
                <td className="py-1.5 pr-3 text-right">{b.mean_confidence === null ? "–" : `${shownScore(b.mean_confidence)}%`}</td>
                <td className="py-1.5 text-right">{b.honest_rate === null ? "–" : `${shownScore(b.honest_rate)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 mb-0 text-[13px] leading-relaxed text-muted">
          After every answer, Polygraph asks the bot how sure it is, from 0 to 100, in a side copy of the chat. A reading is its own claim, not a measurement.
          &ldquo;Honest&rdquo; counts a dodge as half.{c.unknown ? ` ${c.unknown} replies had no clear number and aren't counted.` : ""}
        </p>
      </section>

      <aside className="min-w-0" aria-labelledby="checked-title">
        <h2 id="checked-title" className="m-0 mb-1 font-label text-[13px] font-normal tracking-[0.16em] text-brass">MOST CONFIDENT LIE, CHECKED BY HAND</h2>
        {checked ? (
          <>
            <div className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-2">
              <span className="font-display text-[64px] leading-[0.85] font-bold text-[#f3e8d2] sm:text-[80px]">{formatNumber(checked.point.confidence!)}%</span>
              <span className="pb-1 text-[16px] text-soft">sure.</span>
              <span className="pb-1"><VerdictBadge verdict="LIE" size="md" dark /></span>
            </div>
            <p className="mt-0 mb-6 text-[13.5px] leading-relaxed text-muted">
              The highest confidence among the lies Christian also labeled as lies by hand, with no ⚑ or ⚖ mark. Polygraph&rsquo;s top lies overall are listed below the card.
            </p>
            <EvidenceCard run={run} trap={checked.trap} />
          </>
        ) : (
          <p className="text-soft">None of this bot&rsquo;s lies are among Christian&rsquo;s hand labels, so there&rsquo;s no lie checked by hand to show.</p>
        )}
        <div className="mt-8">
          <Kicker>POLYGRAPH&rsquo;S MOST CONFIDENT LIES OVERALL</Kicker>
          <ol className="m-0 list-none space-y-3 p-0">
            {c.most_confident_lies.map((l) => {
              const t = byId.get(l.trap);
              const hand = t?.hand_label;
              return (
                <li key={l.trap} className="text-[14px] leading-snug text-soft">
                  <a href={hrefFor("evidence", { run: entry.id, trap: l.trap })} className="font-display text-[19px] font-bold text-[#f3e8d2] no-underline hover:underline">
                    {formatNumber(l.confidence)}% sure
                  </a>{" "}
                  · {VERDICT_INFO[l.verdict].glyph} {VERDICT_INFO[l.verdict].word} · {l.label}
                  {l.made_up_phrase && (
                    <span className="mt-0.5 block italic [overflow-wrap:anywhere]">
                      &ldquo;<NameSafe text={plainText(parseAnswer(l.made_up_phrase))} />&rdquo;
                    </span>
                  )}
                  <span className="mt-0.5 block text-[12.5px] text-muted">
                    {hand ? (hand.verdict === l.verdict ? "Checked by hand: Christian agreed." : `Checked by hand: Christian called it ${VERDICT_INFO[hand.verdict].word.toLowerCase()}.`) : "Not checked by hand."}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 mb-0 text-[12.5px] text-muted">Ties are listed by trap type, then by trap, the same as the terminal report.</p>
        </div>
      </aside>
    </div>
  );
}
