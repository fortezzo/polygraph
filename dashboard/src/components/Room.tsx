import type { ReactNode } from "react";

/** Move focus to the screen's main content, for the skip link (and, from App, a new screen). */
export function focusContent(preferHeading: boolean): void {
  const main = document.querySelector<HTMLElement>("main");
  const target = (preferHeading ? main?.querySelector<HTMLElement>("h1") : null) ?? main;
  if (!target) return;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: !preferHeading });
}

/**
 * The near-black room with one warm overhead light and film grain (PLAN.md section 8).
 * Session 11: the first thing a keyboard reaches is "Skip to the content", past the
 * menu and the controls. The grain only moves while a replay plays (see index.css).
 */
export function Room({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-dvh">
      <a
        href="#content"
        className="skip-link"
        onClick={(e) => {
          // The page's address after "#" picks the screen, so this link moves focus itself.
          e.preventDefault();
          focusContent(false);
        }}
      >
        Skip to the content
      </a>
      <div className="lamp" aria-hidden="true" />
      <div className="relative z-10">{children}</div>
      <div className="grain" aria-hidden="true" />
    </div>
  );
}
