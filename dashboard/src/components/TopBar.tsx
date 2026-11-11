import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { hrefFor, type Screen } from "../lib/route";
import { DEMO } from "../lib/demo";

const ALL_TABS: { screen: Screen; label: string; short: string }[] = [
  { screen: "replay", label: "Interrogation room", short: "Replay" },
  { screen: "report", label: "Report card", short: "Report" },
  { screen: "evidence", label: "Evidence wall", short: "Evidence" },
  { screen: "confidence", label: "Overconfidence", short: "Confidence" },
  // The lineup (Session 9): every bot on one wall, ranked by Truth Score.
  { screen: "lineup", label: "Lineup", short: "Lineup" },
  // Live mode (Session 8): start a run and watch it. The live screen counts as this tab.
  { screen: "new", label: "New interrogation", short: "New" },
];

/** The menu. The public demo (Session 10) has no live mode, so no New interrogation tab. */
export function tabsFor(demo: boolean) {
  return demo ? ALL_TABS.filter((t) => t.screen !== "new") : ALL_TABS;
}

const TABS = tabsFor(DEMO);

const FADE = 28; // px of fade at an edge with more tabs past it

/**
 * The wordmark and the menu, on every screen. `children` go on the right: the
 * replay's buttons, or live mode's. Session 11: those buttons show only their
 * icons below 1280 px wide, so the menu never runs under them (it did between
 * 1030 and 1170 px), and on a phone or tablet the menu gets its own row with
 * the tabs spread across it, every tab in view.
 */
export function TopBar({ active, run, children }: { active: Screen; run?: string | null; children?: ReactNode }) {
  // On a small phone the full version's six tabs may not fit: then the row
  // scrolls sideways, the current tab is scrolled into view, and an edge with
  // more tabs past it fades out.
  const phone = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useLayoutEffect(() => {
    const nav = phone.current;
    if (!nav) return;
    const current = nav.querySelector<HTMLElement>("[aria-current=page]");
    if (current) {
      const right = current.offsetLeft + current.offsetWidth + FADE;
      if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth;
    }
    const update = () =>
      setEdges({ left: nav.scrollLeft > 2, right: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2 });
    update();
    nav.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      nav.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);
  const mask = edges.left || edges.right
    ? `linear-gradient(to right, ${edges.left ? "transparent 0, black " + FADE + "px" : "black 0"}, ${edges.right ? `black calc(100% - ${FADE}px), transparent 100%` : "black 100%"})`
    : undefined;

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 lg:flex-nowrap">
      <div className="flex min-w-0 items-center gap-6">
        <a href={hrefFor("replay")} className="font-display text-[20px] leading-[30px] font-semibold tracking-[0.22em] text-[#f3e8d2] no-underline sm:text-[24px] sm:leading-[36px] sm:tracking-[0.24em]">
          POLYGRAPH
        </a>
        <nav aria-label="Screens" className="hidden lg:block">
          <Tabs active={active} run={run} />
        </nav>
      </div>
      {/* Room for the buttons from the start, so the menu doesn't move when they arrive. */}
      <div className="flex min-h-11 items-center gap-2 sm:min-h-[38px]">{children}</div>
      <nav
        ref={phone}
        aria-label="Screens"
        className="relative -mx-1.5 -my-1.5 w-[calc(100%+12px)] overflow-x-auto px-0 py-1.5 [scrollbar-width:none] lg:hidden"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        <Tabs active={active} run={run} compact />
      </nav>
    </header>
  );
}

function Tabs({ active, run, compact }: { active: Screen; run?: string | null; compact?: boolean }) {
  return (
    <ul className={`m-0 flex list-none p-0 ${compact ? "min-w-max justify-between gap-0 sm:justify-start sm:gap-1" : "gap-1"}`}>
      {TABS.map((t) => {
        const on = t.screen === active || (t.screen === "new" && active === "live");
        const keepsRun = t.screen === "report" || t.screen === "evidence" || t.screen === "confidence";
        return (
          <li key={t.screen} className={compact ? "grow sm:grow-0" : undefined}>
            <a
              href={hrefFor(t.screen, keepsRun ? { run } : {})}
              aria-current={on ? "page" : undefined}
              className={`inline-flex h-11 items-center justify-center whitespace-nowrap border-b-2 font-label tracking-[0.04em] no-underline transition-colors lg:h-9 ${
                compact ? "w-full px-1.5 text-[12px] min-[375px]:text-[13px] sm:w-auto sm:px-3 sm:text-[14px]" : "px-3 text-[14px]"
              } ${on ? "border-brass text-[#f3e8d2]" : "border-transparent text-muted hover:text-text"}`}
            >
              {compact ? (
                t.short
              ) : (
                // Session 9: with the Lineup tab, the full names only fit next to the
                // controls on a wide screen. Narrower laptops get the phone's short names.
                <>
                  <span className="min-[1600px]:hidden">{t.short}</span>
                  <span className="hidden min-[1600px]:inline">{t.label}</span>
                </>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
