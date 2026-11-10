import type { ReactNode } from "react";
import type { TrapPlan, View } from "../lib/timeline";
import { VERDICT_INFO } from "../data/verdicts";
import type { Verdict } from "../data/runFile";
import { Icon } from "./Icon";

// The manila case folder. Its two halves are separate grid items: on a laptop
// they stack in the right-hand folder; on a phone the verdict and confidence sit
// right under the chart paper (Christian's change) and the notes come after the
// transcript. Each half is laid out at its final size from the start, with a
// "pending" note on top until the replay gets there, so nothing jumps.

const INK: Record<Verdict, string> = {
  HONEST: "text-honest-ink border-honest-ink",
  LIE: "text-lie-ink border-lie-ink",
  CAVED: "text-caved-ink border-caved-ink",
  CONTRADICTED: "text-contradicted-ink border-contradicted-ink",
  DODGED: "text-dodged-ink border-dodged-ink",
};

function Reveal({ shown, pending, children, className = "" }: { shown: boolean; pending: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <div className={shown ? "" : "invisible"} aria-hidden={!shown}>
        {children}
      </div>
      {!shown && <div className="absolute inset-0 flex items-center">{pending}</div>}
    </div>
  );
}

const Key = ({ children }: { children: ReactNode }) => (
  <div className="mb-0.5 font-label text-[11px] tracking-[0.16em] text-manila-label">{children}</div>
);

export function CaseSummary({ plan, view }: { plan: TrapPlan; view: View }) {
  const v = plan.verdict;
  const info = v ? VERDICT_INFO[v] : null;
  const votes = plan.result.judgement?.votes ?? [];
  const agree = votes.filter((x) => x.verdict === v).length;
  const h = plan.headline;
  return (
    <section
      aria-label={`Verdict for question ${plan.index + 1}`}
      className="area-summary manila relative rounded-[6px] px-4 py-3 lg:rounded-[2px_6px_0_0] lg:px-6 lg:pt-5 lg:pb-3"
    >
      <div className="absolute -top-[22px] left-[18px] hidden h-[26px] rounded-t-[6px] bg-[#b8964f] px-4 pt-[5px] font-label text-[12px] tracking-[0.14em] text-[#2e2416] lg:block">
        CASE NOTES · Q{plan.index + 1}
      </div>
      <div className="flex items-center justify-between gap-3 lg:flex-col lg:items-stretch lg:gap-2">
        <Reveal
          shown={view.verdictShown && !!info}
          className="min-w-0"
          pending={
            <div className="flex items-center gap-2.5 text-manila-label">
              <Icon name="pending" className="h-8 w-8 rounded-full border-2 border-current p-1.5 lg:h-10 lg:w-10" strokeWidth={2.2} />
              <span className="font-label text-[13px] leading-tight tracking-[0.12em]">VERDICT<br />PENDING</span>
            </div>
          }
        >
          {info && v && (
            <div className="flex items-center gap-2.5 lg:gap-3">
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border-[3px] p-1 lg:h-11 lg:w-11 lg:p-1.5 ${INK[v]}`}>
                <Icon name={info.icon} className="h-full w-full" strokeWidth={2.8} />
              </span>
              <span className={`font-display text-[30px] leading-none font-bold tracking-[0.05em] lg:text-[40px] ${INK[v]}`}>{info.word}</span>
              {votes.length > 0 && (
                <span className="ml-1 hidden text-[12px] leading-snug text-manila-label sm:block lg:ml-auto lg:text-right">
                  {agree} of {votes.length}
                  <br />
                  judge votes
                </span>
              )}
            </div>
          )}
        </Reveal>
        <Reveal
          shown={view.finalShown}
          className="shrink-0 text-right lg:text-left"
          pending={
            <div className="flex w-full flex-col items-end gap-1 text-manila-label lg:items-start">
              {/* A blank on the form, to be filled in once the bot says how sure it is. */}
              <div className="h-[40px] w-[96px] rounded-[3px] border-2 border-dashed border-manila-label/45 lg:h-[72px] lg:w-[190px]" />
              <div className="text-[11px] lg:text-[13px]">Asked after its answer</div>
            </div>
          }
        >
          <div className="lg:flex lg:items-end lg:gap-4">
            <div className="font-display text-[46px] leading-[0.95] font-bold text-manila-ink lg:text-[92px] lg:leading-[0.85]">
              {h ? `${h.value}%` : "?"}
            </div>
            <div className="text-[11px] leading-snug text-manila-label lg:max-w-[230px] lg:pb-1 lg:text-[13px] lg:text-manila-ink">
              <span className="lg:hidden">how sure it said it was</span>
              <span className="hidden lg:inline">
                {h
                  ? h.reply !== null
                    ? <>How sure it said it was. It replied &ldquo;{h.reply}&rdquo; when asked {h.basis}.</>
                    : <>How sure it said it was: {h.basis}.</>
                  : "It didn't give a clear number."}
              </span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function CaseDetails({ plan, view }: { plan: TrapPlan; view: View }) {
  const v = plan.verdict;
  const info = v ? VERDICT_INFO[v] : null;
  const t = plan.result.trap;
  const j = plan.result.judgement;
  return (
    <section
      aria-label={`Case notes for question ${plan.index + 1}`}
      className="area-details manila rounded-[6px] px-4 py-4 text-[14px] leading-[1.45] lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:rounded-[0_0_6px_6px] lg:border-t lg:border-dashed lg:border-[#3c2f1a]/40 lg:px-6"
    >
      <Reveal
        shown={view.finalShown}
        pending={<p className="m-0 self-start pt-1 text-manila-label">The judge&rsquo;s notes and the truth come in after the answer.</p>}
      >
        <div className="flex flex-col gap-3">
          {info && plan.result.reason && (
            <div>
              <Key>{info.reasonHeading}</Key>
              {plan.result.reason}
              {j?.own_knowledge && (
                <p className="mt-1 mb-0 text-[13px] text-manila-label">⚑ This rests on the judge&rsquo;s own knowledge, not the hand-checked truth. Worth checking.</p>
              )}
              {j?.unsettled && (
                <p className="mt-1 mb-0 text-[13px] text-manila-label">⚖ The judge&rsquo;s votes were tied, so the milder verdict is shown.</p>
              )}
            </div>
          )}
          <div>
            <Key>THE TRUTH</Key>
            {t.truth}
          </div>
          <div>
            <Key>SOURCE</Key>
            {t.source.url ? (
              <a className="text-manila-ink underline decoration-manila-label/60 underline-offset-2" href={t.source.url} target="_blank" rel="noreferrer">
                {t.source.title}
              </a>
            ) : (
              t.source.title
            )}
          </div>
        </div>
      </Reveal>
    </section>
  );
}
