// Which screen is showing, from the part of the address after "#", like
// "#/evidence?run=…&type=fake_citation". Hash addresses work on any static host
// (GitHub Pages in Session 10) and can be bookmarked or shared.

import { useEffect, useState } from "react";

export type Screen = "replay" | "report" | "evidence" | "confidence" | "lineup" | "new" | "live";
const SCREENS: readonly Screen[] = ["replay", "report", "evidence", "confidence", "lineup", "new", "live"];

export interface Route {
  screen: Screen;
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const q = h.indexOf("?");
  const path = q >= 0 ? h.slice(0, q) : h;
  const query = q >= 0 ? h.slice(q + 1) : "";
  return { screen: (SCREENS as readonly string[]).includes(path) ? (path as Screen) : "replay", params: new URLSearchParams(query) };
}

export function hrefFor(screen: Screen, params: Record<string, string | null | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `#/${screen}${s ? `?${s}` : ""}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** Change the address without adding a step to the browser's back button (for filters). */
export function replaceHash(href: string): void {
  window.history.replaceState(null, "", href);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
