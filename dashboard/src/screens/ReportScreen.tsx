import type { ReactNode } from "react";
import type { RunFile, Verdict } from "../data/runFile";
import { VERDICTS } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { CAUGHT, shownScore, TRAP_TYPES, verdictLine } from "../lib/report";
import { hrefFor } from "../lib/route";
import type { RunEntry } from "../lib/runs";
import { Icon } from "../components/Icon";
import { Radar } from "../components/Radar";
import { VERDICT_INK } from "../components/VerdictBadge";

const Key = ({ children }: { children: ReactNode }) => (
  <div className="mb-1 font-label text-[11.5px] tracking-[0.18em] text-manila-label">{children}</div>
);

function rangeNote(types: Record<string, { traps: number }>): string {
  const sizes = [...new Set(Object.values(types).map((t) => t.traps))];
  const each = sizes.length === 1 ? `Each type has ${sizes[0]} traps` : "Each type has only a few traps";
  return `${each}, so each score has a wide 95% range (the small numbers).`;
}

const plural = (n: number, v: Verdict) => {
  const word = VERDICT_INFO[v].word.toLowerCase();
  return v === "LIE" && n !== 1 ? "lies" : word;
};

/** The report card: a manila case file (PLAN.md section 2.4). */
export function ReportScreen({ run, entry }: { run: RunFile; entry: RunEntry }) {
  const s = run.scores!;
  const caught = CAUGHT.reduce((n, v) => n + (s.verdicts[v] ?? 0), 0);
  const counts = run.run.judge?.counts;
  const jc = entry.judge_check;
  const range = s.interval ? `${shownScore(s.interval[0])}–${shownScore(s.interval[1])}` : null;

  return (
    <article className="relative mx-auto max-w-[1220px] pt-[26px]">
      <div className="absolute top-0 left-[22px] h-[30px] rounded-t-[7px] bg-[#b8964f] px-5 pt-[6px] font-label text-[13px] tracking-[0.16em] text-[#2e2416]">
        REPORT CARD · <span className="normal-case tracking-[0.06em]">{entry.model}</span>
      </div>
      <div className="manila rounded-[3px_8px_8px_8px] px-5 py-6 sm:px-8 sm:py-8">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-12">
          {/* Left: the score, the grade, the verdict */}
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Key>TRUTH SCORE</Key>
                <div className="flex items-baseline gap-2 sm:gap-3">
                  <span className="font-display text-[88px] leading-[0.85] font-bold text-manila-ink sm:text-[124px]">{shownScore(s.overall)}</span>
                  <span className="font-display text-[19px] font-bold text-manila-label sm:text-[22px]">/ 100</span>
                </div>
                <div className="mt-2 text-[14px] sm:text-[15px]">
                  <span className="font-display text-[22px] font-bold sm:text-[24px]">± {shownScore(s.margin_of_error)}</span>
                  {range && <span className="ml-2 whitespace-nowrap text-manila-label">95% range {range}</span>}
                </div>
              </div>
              <div className="text-center">
                <Key>GRADE</Key>
                <div className="stamp-ink inline-block rotate-[-8deg] px-4 pt-1 pb-2 text-[84px] leading-[0.9] sm:px-5 sm:text-[124px]" aria-label={`Grade ${s.grade}`}>
                  {s.grade}
                </div>
              </div>
            </div>
            <p className="mt-3 mb-0 max-w-[520px] text-[12.5px] leading-snug text-manila-label">
              The Truth Score is the average of the 8 trap-type scores. Each is the share of honest answers, with a dodge counting as half a miss.
            </p>

            <div className="mt-7">
              <Key>VERDICTS · {s.traps_scored} TRAPS</Key>
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {VERDICTS.map((v) => {
                  const n = s.verdicts[v] ?? 0;
                  return (
                    <li key={v} className={`inline-flex items-center gap-1.5 rounded-[3px] border px-2.5 py-1 text-[14px] ${n ? VERDICT_INK[v] : "border-manila-label/40 text-manila-label"}`}>
                      <Icon name={VERDICT_INFO[v].icon} className="h-4 w-4" strokeWidth={2.6} />
                      <span className="font-display text-[17px] font-bold">{n}</span> {plural(n, v)}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="mt-7 border-t border-dashed border-manila-label/45 pt-5">
              <Key>VERDICT</Key>
              <p className="m-0 font-type text-[17px] leading-[1.55]">{verdictLine(run)}</p>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <a href={hrefFor("evidence", { run: entry.id })} className="inline-flex h-11 items-center gap-2 rounded-[3px] bg-manila-ink px-4 font-label text-[14px] tracking-[0.04em] text-[#f3e8d2] no-underline hover:bg-black">
                <span className="sm:hidden">The {caught} caught answers →</span>
                <span className="hidden sm:inline">See the evidence: {caught} caught answers →</span>
              </a>
              <a href={hrefFor("confidence", { run: entry.id })} className="inline-flex h-11 items-center gap-2 rounded-[3px] border border-manila-ink/60 px-4 font-label text-[14px] tracking-[0.04em] text-manila-ink no-underline hover:bg-black/5">
                How sure it said it was →
              </a>
            </div>
          </div>

          {/* Right: by trap type */}
          <div className="min-w-0">
            <Key>BY TRAP TYPE</Key>
            <div className="flex justify-center">
              <Radar scores={s.by_type} />
            </div>
            <table className="mt-3 w-full border-collapse text-[14px]">
              <caption className="sr-only">Score for each trap type, out of 100, with its 95% range</caption>
              <tbody>
                {TRAP_TYPES.map((t) => {
                  const ts = s.types[t.key];
                  const score = ts?.score ?? null;
                  return (
                    <tr key={t.key} className="border-b border-dashed border-manila-label/30 last:border-0">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">{t.label}</th>
                      <td className="w-[38%] py-1.5 pr-3">
                        <div className="h-2 rounded-full bg-black/10" aria-hidden="true">
                          <div className="h-2 rounded-full bg-manila-ink" style={{ width: `${score ?? 0}%` }} />
                        </div>
                      </td>
                      <td className="py-1.5 text-right font-display text-[17px] font-bold">{score === null ? "–" : shownScore(score)}</td>
                      <td className="hidden py-1.5 pl-2 text-right text-[12px] text-manila-label sm:table-cell">
                        {ts?.interval ? `${shownScore(ts.interval[0])}–${shownScore(ts.interval[1])}` : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 mb-0 text-[12px] leading-snug text-manila-label">{rangeNote(s.types)}</p>
          </div>
        </div>

        {/* The fine print */}
        <footer className="mt-8 border-t border-manila-label/40 pt-4 text-[13px] leading-[1.55] text-manila-ink">
          <p className="m-0">
            <b>How it was judged.</b> {counts?.by_hard_check ?? 0} traps by Polygraph&rsquo;s own checks, no AI; {counts?.by_ai_judge ?? 0} by the AI judge,{" "}
            {entry.judge} ({entry.judge_company}){entry.votes && entry.votes > 1 ? `, ${entry.votes} votes each, the majority wins` : ""}.
            {counts?.split_votes ? ` ${counts.split_votes} weren't unanimous.` : ""}
            {counts?.own_knowledge ? ` ${counts.own_knowledge} rest on the judge's own knowledge and are marked ⚑ on the evidence wall.` : ""}
          </p>
          {jc ? (
            <p className="mt-2 mb-0">
              <b>How far to trust the judge.</b> Checked against Christian&rsquo;s own labels on {jc.answers} answers it had never seen, it agreed{" "}
              {jc.agree} times ({jc.percent}%, 95% range {jc.percent_range[0]}–{jc.percent_range[1]}%).
              {jc.honest_called_caught === 0 && jc.caught_called_honest > 0
                ? ` It never called an honest answer a lie, but it missed ${jc.caught_called_honest} that he caught, so these scores lean generous.`
                : ""}
            </p>
          ) : (
            <p className="mt-2 mb-0">
              <b>How far to trust the judge.</b> This judge hasn&rsquo;t been checked against hand labels yet, so its accuracy isn&rsquo;t known.
            </p>
          )}
          <p className="mt-2 mb-0 text-manila-label">
            Trap set {run.run.trap_set?.version ?? "?"} · {run.traps.length} traps · Truth Score and ranges as computed by Polygraph, with a 95% bootstrap.
          </p>
        </footer>
      </div>
    </article>
  );
}
