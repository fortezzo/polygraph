// Session 11: walk every screen with the Tab key alone, as a keyboard user would.
// For each stop: what it is, what a screen reader calls it, and whether its focus
// outline can be seen (an outline or a ring, in a color that stands out from what's
// behind it). Also checks "Skip to the content" and that focus moves to a new
// screen's heading.
//
//   npm run build:demo && node scripts/keyboard-walk.mjs [--url <site>] [--tabs 40]

import { preview } from "vite";
import { chromium } from "playwright-core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const tabs = Number(opt("--tabs", 40));
let base = opt("--url", null);
let server = null;
if (!base) {
  server = await preview({ root: dashboard, logLevel: "silent", preview: { port: 4176, strictPort: false, host: "127.0.0.1" } });
  base = server.resolvedUrls.local[0];
}
if (!base.endsWith("/")) base += "/";

const SCREENS = [
  { url: "?paused", name: "the replay (Highlights)" },
  { url: "?paused#/replay?run=2026-11-10_13-02-10_ollama_llama3.2", name: "a whole recording" },
  { url: "#/report", name: "the report card", ready: true },
  { url: "#/evidence", name: "the evidence wall", ready: true },
  { url: "#/confidence", name: "the overconfidence meter", ready: true },
  { url: "#/lineup", name: "the lineup", ready: true },
];

const browser = await chromium.launch({ channel: "msedge", headless: true });
let problems = 0;
try {
  for (const s of SCREENS) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base + s.url, { waitUntil: "networkidle" });
    if (s.ready) await page.waitForSelector("main[data-ready]");
    else await page.waitForFunction(() => window.polygraph?.ready);
    const stops = [];
    for (let i = 0; i < tabs; i++) {
      await page.keyboard.press("Tab");
      // Buttons fade their colors (outline included) in 0.15 s: measure once that has finished.
      await page.waitForTimeout(250);
      const info = await page.evaluate(() => {
        const focused = document.activeElement;
        if (!focused || focused === document.body) return null;
        // The pickers (Session 11): the real dropdown is invisible, laid over its label,
        // and the label draws the focus ring. Check what can be seen.
        const el = focused.tagName === "SELECT" && Number(getComputedStyle(focused).opacity) === 0 ? focused.closest("label") ?? focused : focused;
        const cs = getComputedStyle(el);
        const name = (focused.getAttribute("aria-label") || (focused.tagName === "SELECT" ? `${focused.labels?.[0]?.querySelector(".sr-only")?.textContent ?? "picker"}: ${focused.selectedOptions[0]?.textContent ?? ""}` : focused.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 60);
        const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2;
        // What's behind the outline: it's drawn just outside the element, so the first
        // ancestor with a background color or image (Tailwind writes see-through colors as
        // "oklab(… / 0.03)": a faint tint isn't what the eye sees behind it).
        let bg = "rgb(12, 10, 8)";
        for (let e = el.parentElement; e; e = e.parentElement) {
          const b = getComputedStyle(e);
          if (b.backgroundImage !== "none" && e.matches(".manila, .card-paper, .paper, .chart-panel, .placard")) { bg = "rgb(220, 190, 130)"; break; }
          // A faint tint (like 3% black on a card) isn't what the eye sees behind the outline.
          const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(b.backgroundColor)?.[1] ?? /\/\s*([\d.]+)\s*\)/.exec(b.backgroundColor)?.[1];
          if (b.backgroundColor && b.backgroundColor !== "transparent" && (alpha === undefined || Number(alpha) >= 0.5)) { bg = b.backgroundColor; break; }
        }
        const rgb = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const lum = ([r, g, b]) => {
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const a = lum(rgb(cs.outlineColor));
        const b = lum(rgb(bg));
        const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        return { tag: el.tagName.toLowerCase(), name, outline, contrast: +contrast.toFixed(2), visible: el.getBoundingClientRect().width > 0 };
      });
      if (!info) break;
      stops.push(info);
    }
    const bad = stops.filter((x) => !x.outline || x.contrast < 3 || !x.visible);
    problems += bad.length;
    console.log(`\n${s.name}: ${stops.length} Tab stops`);
    console.log(`  ${stops.map((x) => `${x.tag}"${x.name.slice(0, 26)}"`).join(" → ")}`);
    for (const b of bad) console.log(`  PROBLEM: ${b.tag} "${b.name}" ${!b.outline ? "has no outline" : ""} ${b.contrast < 3 ? `outline contrast ${b.contrast} (needs 3)` : ""} ${!b.visible ? "is invisible" : ""}`);
    await page.close();
  }

  // "Skip to the content", and focus moving to a new screen's heading.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + "#/report", { waitUntil: "networkidle" });
  await page.waitForSelector("main[data-ready]");
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.keyboard.press("Enter");
  const afterSkip = await page.evaluate(() => document.activeElement?.tagName.toLowerCase() + "#" + document.activeElement?.id);
  await page.getByRole("link", { name: "Lineup" }).first().click();
  await page.waitForSelector("main[data-ready]");
  await page.waitForTimeout(300);
  const afterNav = await page.evaluate(() => `${document.activeElement?.tagName.toLowerCase()} "${document.activeElement?.textContent?.trim().slice(0, 50)}"`);
  console.log(`\nfirst Tab stop: "${first}"; Enter on it moves focus to ${afterSkip}; after opening the Lineup, focus is on ${afterNav}`);
  if (first !== "Skip to the content" || afterSkip !== "main#content" || !afterNav.startsWith("h1")) problems += 1;
  await page.close();
  console.log(`\n${problems ? `${problems} problems` : "no problems"}`);
} finally {
  await browser.close();
  if (server) await new Promise((r) => server.httpServer.close(r));
}
