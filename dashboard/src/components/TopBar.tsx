import type { ReactNode } from "react";
import { hrefFor, type Screen } from "../lib/route";

const TABS: { screen: Screen; label: string; short: string }[] = [
  { screen: "replay", label: "Interrogation room", short: "Replay" },
  { screen: "report", label: "Report card", short: "Report" },
  { screen: "evidence", label: "Evidence wall", short: "Evidence" },
  { screen: "confidence", label: "Overconfidence", short: "Confidence" },
];

/** The wordmark and the menu, on every screen. `children` go on the right. */
export function TopBar({ active, run, children }: { active: Screen; run?: string | null; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 lg:flex-nowrap">
      <div className="flex min-w-0 items-center gap-6">
        <a href={hrefFor("replay")} className="font-display text-[20px] font-semibold tracking-[0.22em] text-[#f3e8d2] no-underline sm:text-[24px] sm:tracking-[0.24em]">
          POLYGRAPH
        </a>
        <nav aria-label="Screens" className="hidden lg:block">
          <Tabs active={active} run={run} />
        </nav>
      </div>
      {/* Room for the controls from the start, so the menu doesn't move when they arrive. */}
      <div className="flex min-h-11 items-center gap-2 sm:min-h-[38px]">{children}</div>
      <nav aria-label="Screens" className="-mx-1 w-full overflow-x-auto lg:hidden">
        <Tabs active={active} run={run} compact />
      </nav>
    </header>
  );
}

function Tabs({ active, run, compact }: { active: Screen; run?: string | null; compact?: boolean }) {
  return (
    <ul className="m-0 flex list-none gap-1 p-0">
      {TABS.map((t) => {
        const on = t.screen === active;
        return (
          <li key={t.screen}>
            <a
              href={hrefFor(t.screen, t.screen === "replay" ? {} : { run })}
              aria-current={on ? "page" : undefined}
              className={`inline-flex h-11 items-center whitespace-nowrap border-b-2 px-3 font-label text-[14px] tracking-[0.04em] no-underline transition-colors lg:h-9 ${
                on ? "border-brass text-[#f3e8d2]" : "border-transparent text-muted hover:text-text"
              }`}
            >
              {compact ? t.short : t.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
