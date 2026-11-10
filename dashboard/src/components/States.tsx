import type { ReactNode } from "react";
import { Icon } from "./Icon";

// Loading, empty and error states (PLAN.md section 8: every screen has all three).

function Card({ kicker, title, children, live }: { kicker: string; title: string; children?: ReactNode; live?: "polite" | "assertive" }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[640px] flex-col justify-center px-4 py-10">
      <div className="font-display text-[22px] font-semibold tracking-[0.24em] text-[#f3e8d2]">POLYGRAPH</div>
      <div className="paper mt-6 h-[110px] sm:h-[140px]" aria-hidden="true">
        <div className="paper-grid">
          <div className="paper-holes top-0" />
          <div className="paper-holes bottom-0" />
        </div>
        <div className="paper-light" />
        <div className="absolute inset-x-[16px] top-1/2 border-t-2 border-[#1b6a3e]/70" />
      </div>
      <section className="mt-7" aria-live={live}>
        <div className="font-label text-[13px] tracking-[0.14em] text-brass">{kicker}</div>
        <h2 className="mt-2 mb-0 font-type text-[22px] leading-snug font-bold text-text">{title}</h2>
        {children && <div className="mt-3 text-[15px] leading-relaxed text-soft">{children}</div>}
      </section>
    </main>
  );
}

/** A loading, empty or error message inside a screen, under the menu. */
export function StatePanel({ kicker, title, children, live, onRetry, retryLabel = "Try again" }: { kicker: string; title: string; children?: ReactNode; live?: "polite" | "assertive"; onRetry?: () => void; retryLabel?: string }) {
  return (
    <section className="mx-auto mt-6 w-full max-w-[640px]" aria-live={live}>
      <div className="paper h-[90px] sm:h-[110px]" aria-hidden="true">
        <div className="paper-grid">
          <div className="paper-holes top-0" />
          <div className="paper-holes bottom-0" />
        </div>
        <div className="paper-light" />
        <div className="absolute inset-x-[16px] top-1/2 border-t-2 border-[#1b6a3e]/70" />
      </div>
      <div className="mt-6 font-label text-[13px] tracking-[0.14em] text-brass">{kicker}</div>
      <h2 className="mt-2 mb-0 font-type text-[21px] leading-snug font-bold text-text">{title}</h2>
      {children && <div className="mt-3 text-[15px] leading-relaxed text-soft">{children}</div>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex h-11 items-center gap-2 rounded-[4px] border border-text/25 bg-white/[0.04] px-4 font-label text-[14px] text-text hover:bg-white/[0.08]"
        >
          <Icon name="restart" className="h-[18px] w-[18px]" />
          {retryLabel}
        </button>
      )}
    </section>
  );
}

export function Loading() {
  return (
    <Card kicker="LOADING" title="Bringing in the subject…" live="polite">
      <p className="m-0 text-muted">Setting up the interrogation room.</p>
    </Card>
  );
}

export function Empty() {
  return (
    <Card kicker="NOTHING TO REPLAY" title="This recording has no questions in it.">
      <p className="m-0">
        Record an interrogation with <code className="rounded bg-white/8 px-1.5">polygraph run</code> in the <b>run</b> tab, then come back to replay it.
      </p>
    </Card>
  );
}

export function ErrorState({ title, detail, onRetry }: { title: string; detail: string; onRetry?: () => void }) {
  return (
    <Card kicker="SOMETHING WENT WRONG" title={title} live="assertive">
      <p className="m-0">{detail}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex h-11 items-center gap-2 rounded-[4px] border border-text/25 bg-white/[0.04] px-4 font-label text-[14px] text-text hover:bg-white/[0.08]"
        >
          <Icon name="restart" className="h-[18px] w-[18px]" />
          Play the sample instead
        </button>
      )}
    </Card>
  );
}
