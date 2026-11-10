import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { hrefFor, type Screen } from "../lib/route";

const TABS: { screen: Screen; label: string; short: string }[] = [
  { screen: "replay", label: "Interrogation room", short: "Replay" },
  { screen: "report", label: "Report card", short: "Report" },
  { screen: "evidence", label: "Evidence wall", short: "Evidence" },
  { screen: "confidence", label: "Overconfidence", short: "Confidence" },
  // Live mode (Session 8): start a run and watch it. The live screen counts as this tab.
  { screen: "new", label: "New interrogation", short: "New" },
];

const FADE = 28; // px of fade at an edge with more tabs past it

/** The wordmark and the menu, on every screen. `children` go on the right. */
export function TopBar({ active, run, children }: { active: Screen; run?: string | null; children?: ReactNode }) {
  // On a phone the menu scrolls sideways: the current tab is scrolled into view,
  // and an edge with more tabs past it fades out.
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
      <nav
        ref={phone}
        aria-label="Screens"
        className="relative -mx-1 w-full overflow-x-auto lg:hidden"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        <Tabs active={active} run={run} compact />
      </nav>
    </header>
  );
}

function Tabs({ active, run, compact }: { active: Screen; run?: string | null; compact?: boolean }) {
  return (
    <ul className={`m-0 flex list-none p-0 ${compact ? "gap-0" : "gap-1"}`}>
      {TABS.map((t) => {
        const on = t.screen === active || (t.screen === "new" && active === "live");
        const keepsRun = t.screen === "report" || t.screen === "evidence" || t.screen === "confidence";
        return (
          <li key={t.screen}>
            <a
              href={hrefFor(t.screen, keepsRun ? { run } : {})}
              aria-current={on ? "page" : undefined}
              className={`inline-flex h-11 items-center whitespace-nowrap border-b-2 font-label text-[14px] tracking-[0.04em] no-underline transition-colors lg:h-9 ${
                compact ? "px-[10px]" : "px-3"
              } ${on ? "border-brass text-[#f3e8d2]" : "border-transparent text-muted hover:text-text"}`}
            >
              {compact ? t.short : t.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
