// Session 11: the polish audit. Every screen of the demo, at seven sizes from a
// small phone to a large monitor, photographed and measured.
//
//   npm run build:demo && node scripts/polish-audit.mjs --out <folder>
//   node scripts/polish-audit.mjs --url https://fortezzo.github.io/polygraph/ --out <folder>
//   node scripts/polish-audit.mjs --only 05 --sizes phone,laptop --out <folder>
//   node scripts/polish-audit.mjs --menu-sweep --out <folder>     the menu at every width from 1000 to 1700 px
//
// What it measures on every screen, beyond the screenshot:
// - the page running off the side (anything wider than the screen, outside a scroller)
// - text cut short (an ellipsis, or text clipped by its box)
// - things overlapping each other (buttons, links, labels and lines of text)
// - tap targets smaller than 24 × 24 px (WCAG 2.2, 2.5.8), and on a phone smaller than 44 px
// - text smaller than 12 px
// - where the chart paper starts, and on a caught answer whether the CAUGHT stamp is
//   still on the paper
// It uses the Microsoft Edge already on this PC, invisibly.

import { preview } from "vite";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const remote = opt("--url", null);
const out = resolve(opt("--out", resolve(process.env.TEMP ?? dashboard, "polygraph-audit")));
const only = opt("--only", null);
const sweep = args.includes("--menu-sweep");
const quality = Number(opt("--quality", 72));
mkdirSync(out, { recursive: true });

export const SIZES = {
  "phone-s": { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, label: "Small phone, 360 × 780" },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, label: "Phone, 390 × 844" },
  tablet: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true, label: "Tablet, 768 × 1024" },
  "laptop-n": { viewport: { width: 1060, height: 800 }, deviceScaleFactor: 1, label: "Narrow laptop window, 1060 × 800" },
  "laptop-s": { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, label: "Laptop, 1366 × 768" },
  laptop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, label: "Laptop, 1440 × 900" },
  desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, label: "Monitor, 1920 × 1080" },
};
const sizes = (opt("--sizes", null)?.split(",") ?? Object.keys(SIZES)).filter((s) => SIZES[s]);

const LLAMA = "2026-11-10_13-02-10_ollama_llama3.2";
const GEMMA3 = "2026-11-10_13-08-46_ollama_gemma3-12b";
const GEMMA4 = "2026-11-10_19-02-51_ollama_gemma4-12b";
const NEVER = "2026-11-10_13-05-55_ollama_llama3.2";
const QWEN = "2026-11-10_13-02-02_openai_gpt-6-luna--qwen3.6-35b";

const mark = (marks, trap, name) => {
  const m = marks.find((x) => x.trap === trap && x.name === name);
  if (!m) throw new Error(`no mark ${trap} ${name}`);
  return m.t;
};
const firstCaught = (marks) => marks.find((m) => m.name === "stamp");

// Each moment: an address, then (for the replay) a time to show, or something to do.
export const MOMENTS = [
  { name: "01-highlights-question", note: "The first page. A question types itself out (ghost-004).", url: "?paused", at: (m) => mark(m, "ghost-004", "question") + 900 },
  { name: "02-highlights-streaming", note: "An answer streams in, with the needle calm (limits-002).", url: "?paused", at: (m) => mark(m, "limits-002", "answer") + 1200 },
  { name: "03-highlights-spike", note: "The made-up words stream in and the needle spikes (ghost-004).", url: "?paused", at: (m) => mark(m, "ghost-004", "spike") + 250 },
  { name: "04-highlights-stamp", note: "The CAUGHT stamp has just landed (ghost-004).", url: "?paused", at: (m) => mark(m, "ghost-004", "stamp") + 700 },
  { name: "05-highlights-verdict", note: "The verdict and the confidence (98%) show. Is the spike still on the paper?", url: "?paused", at: (m) => mark(m, "ghost-004", "final") + 1200, stampCheck: "ghost-004" },
  { name: "06-highlights-four-chats", note: "A consistency trap: the same question in 4 new chats (consistency-003).", url: "?paused", at: (m) => mark(m, "consistency-003", "final") + 900 },
  { name: "07-highlights-caved", note: "A push-back, and the bot caves (pressure-002).", url: "?paused", at: (m) => mark(m, "pressure-002", "final") + 900, stampCheck: "pressure-002" },
  { name: "08-highlights-document", note: "A document trap, with its exhibit (document-004).", url: "?paused", at: (m) => mark(m, "document-004", "final") + 900 },
  { name: "09-highlights-over", note: "The end of the Highlights.", url: "?paused", at: (m, d) => d + 50 },
  { name: "10-recording", note: "A whole recording: all 200 of Llama 3.2's questions, at its first caught answer.", url: `?paused#/replay?run=${LLAMA}`, at: (m) => firstCaught(m).t + 700 },
  { name: "11-recording-verdict", note: "The same caught answer, when its confidence shows.", url: `?paused#/replay?run=${LLAMA}`, at: (m) => mark(m, firstCaught(m).trap, "final") + 1200, stampCheck: (m) => firstCaught(m).trap },
  { name: "12-recording-8x", note: "A whole recording playing at 8×.", url: `#/replay?run=${LLAMA}`, act: async (page) => { await page.getByRole("button", { name: "Play at 8 times speed" }).click(); await page.waitForTimeout(2500); } },
  { name: "13-never-unsure", note: "Never Unsure: a custom bot, with its instructions.", url: `?paused#/replay?run=${NEVER}`, at: (m) => firstCaught(m).t + 700 },
  { name: "14-empty-answer", note: "Gemma 4's empty answer (citation-004).", url: `?paused#/replay?run=${GEMMA4}`, at: (m) => mark(m, "citation-004", "final") + 900 },
  { name: "15-missing-recording", note: "An address for a recording that isn't on the site.", url: "#/replay?run=no-such-recording", wait: "text=That recording isn't here" },
  { name: "16-replay-loading", note: "The replay's loading state.", url: "?state=loading", wait: "text=LOADING" },
  { name: "17-replay-empty", note: "The replay's empty state.", url: "?state=empty", wait: "main, [role=status], h1" },
  { name: "18-replay-error", note: "The replay's error state.", url: "?state=error", wait: "main, [role=alert], h1" },
  { name: "19-report", note: "The report card (Gemma 3 12B, the default).", url: "#/report", ready: true, full: true },
  { name: "20-report-llama", note: "Llama 3.2's report card.", url: `#/report?run=${LLAMA}`, ready: true },
  { name: "21-report-custom", note: "A custom bot's report card (Never Unsure).", url: `#/report?run=${NEVER}`, ready: true },
  { name: "22-report-second-opinion", note: "A second opinion (gpt-6-luna's grades of Gemma 3).", url: `#/report?run=${GEMMA3}--gpt-6-luna`, ready: true },
  { name: "23-report-replaced", note: "Qwen's replaced grades.", url: `#/report?run=${QWEN}`, ready: true },
  { name: "24-evidence", note: "The evidence wall (default filters).", url: "#/evidence", ready: true, full: true },
  { name: "25-evidence-citations", note: "Fake citation cards.", url: "#/evidence?type=fake_citation", ready: true, full: true },
  { name: "26-evidence-consistency", note: "Consistency cards (4 chats).", url: "#/evidence?type=consistency", ready: true },
  { name: "27-evidence-pushback", note: "Pressure-test cards (both answers).", url: "#/evidence?type=pressure_test", ready: true },
  { name: "28-evidence-none", note: "No cards match the filters.", url: "#/evidence?type=fake_citation&verdict=CONTRADICTED", ready: true },
  { name: "29-confidence", note: "The overconfidence meter.", url: "#/confidence", ready: true, full: true },
  { name: "30-confidence-llama", note: "Llama 3.2's meter, with its misread-looking readings.", url: `#/confidence?run=${LLAMA}`, ready: true },
  { name: "31-lineup", note: "The lineup.", url: "#/lineup", ready: true, full: true },
  { name: "32-lineup-judge", note: "The lineup, opened on a judge's card.", url: "#/lineup?judge=claude-haiku-5-5", ready: true },
  { name: "33-data-loading", note: "A data screen's loading state.", url: "?state=loading#/report", wait: "text=Opening the case file" },
  { name: "34-data-empty", note: "A data screen's empty state.", url: "?state=empty#/report", wait: "h1, h2" },
  { name: "35-data-error", note: "A data screen's error state.", url: "?state=error#/report", wait: "h1, h2" },
  { name: "36-lineup-error", note: "The lineup's error state.", url: "?state=error#/lineup", wait: "h1, h2" },
  { name: "37-not-in-demo", note: "The New interrogation address, on the demo.", url: "#/new", wait: "text=NOT IN THIS DEMO" },
];

// ---- Measurements, run inside the page ------------------------------------------
function measure(opts) {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const phone = vw < 640;
  const vis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const srOnly = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.clipPath !== "none" && cs.position === "absolute" && e.getBoundingClientRect().width <= 1) return true;
      if (e.classList?.contains("sr-only")) return true;
    }
    return false;
  };
  const inside = (el, sel) => !!el.closest(sel);
  const scroller = (el) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const ox = getComputedStyle(e).overflowX;
      if (ox !== "visible") return e;
    }
    return null;
  };
  const describe = (el) => {
    const t = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50);
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 3).join(".") : "";
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} "${t}"`;
  };
  const sy = window.scrollY;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const all = [...document.querySelectorAll("body *")].filter((el) => !inside(el, ".grain, .lamp, svg, canvas") && vis(el) && !srOnly(el));

  // 1. Anything running off the side of the screen, outside a scroller.
  const offside = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.right <= vw + 1 && r.left >= -1) continue;
    const s = scroller(el);
    if (s) {
      const sr = s.getBoundingClientRect();
      if (sr.right <= vw + 1 && sr.left >= -1) continue; // it scrolls inside a box that fits
    }
    offside.push({ el: describe(el), box: box(el) });
  }

  // 2. Text cut short: an ellipsis or clipped text.
  const cut = [];
  for (const el of all) {
    if (!el.childNodes.length || inside(el, ".paper")) continue;
    const cs = getComputedStyle(el);
    const clips = cs.overflowX !== "visible" || cs.textOverflow === "ellipsis";
    if (!clips) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (el.tagName === "SELECT") {
      // A <select> shows its picked option: is that label wider than the box?
      const o = el.selectedOptions[0];
      if (!o) continue;
      const c = document.createElement("canvas").getContext("2d");
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const need = c.measureText(o.textContent).width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 22;
      if (need > el.clientWidth + 1) cut.push({ el: describe(el), label: o.textContent, needs: Math.round(need), has: el.clientWidth });
      continue;
    }
    if (hasText && el.scrollWidth > el.clientWidth + 1) cut.push({ el: describe(el), needs: el.scrollWidth, has: el.clientWidth });
  }

  // 3. Overlaps between controls, links, labels and lines of text. A small allowance
  // for line boxes that touch; parents and children never count.
  // Only what can be seen: a closed <details> hides its contents, and a scrolling
  // box (the transcript) clips what has scrolled out of it.
  const closedDetails = (el) => {
    const d = el.closest("details:not([open])");
    return !!d && !el.closest("summary");
  };
  const clipped = (el) => {
    let r = el.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const c = e.getBoundingClientRect();
      left = Math.max(left, c.left);
      top = Math.max(top, c.top);
      right = Math.min(right, c.right);
      bottom = Math.min(bottom, c.bottom);
    }
    return { left, top, right, bottom };
  };
  const leaves = all.filter((el) => {
    if (inside(el, ".paper, .lineup-meter, .lineup-marks, .stamp-ink") || closedDetails(el)) return false;
    const tag = el.tagName;
    // A link inside a sentence can wrap onto the next line; its box then spans both lines.
    if (tag === "A" && getComputedStyle(el).display === "inline") return false;
    if (["A", "BUTTON", "SELECT", "INPUT", "LABEL", "SUMMARY"].includes(tag)) return true;
    return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && getComputedStyle(el).display !== "inline";
  });
  const rects = leaves.map((el) => ({ el, r: clipped(el) })).filter((x) => x.r.right - x.r.left > 0 && x.r.bottom - x.r.top > 0);
  const overlaps = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 3 && h > 3 && w * h > 30) overlaps.push({ a: describe(a.el), b: describe(b.el), w: Math.round(w), h: Math.round(h), at: box(a.el) });
    }
    if (overlaps.length > 40) break;
  }

  // 4. Tap targets: under 24 × 24 px (WCAG 2.5.8), or under 44 px on a phone.
  // Links inside a sentence are exempt, as WCAG allows.
  const small = [];
  const under44 = [];
  for (const el of document.querySelectorAll("a[href], button, select, input, summary, [role=button], [role=tab], [tabindex='0']")) {
    if (!vis(el) || srOnly(el)) continue;
    const r = el.getBoundingClientRect();
    const inline = getComputedStyle(el).display === "inline" && el.tagName === "A" && el.parentElement && el.parentElement.textContent.trim().length > el.textContent.trim().length + 5;
    if (inline) continue;
    if (r.width < 24 || r.height < 24) small.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
    else if (phone && (r.width < 44 || r.height < 44)) under44.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
  }

  // 5. Text under 12 px.
  const tiny = new Map();
  for (const el of all) {
    if (inside(el, ".paper")) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 12) {
      const k = `${fs}px`;
      const list = tiny.get(k) ?? [];
      if (list.length < 4) list.push(describe(el));
      tiny.set(k, list);
    }
  }

  // 6. The chart paper, and the stamp on it.
  const paper = document.querySelector(".paper");
  let stamp = null;
  if (paper && opts.stampCheck) {
    const pr = paper.getBoundingClientRect();
    // Real stamps only: not one that hasn't landed (hidden), nor the hidden copy ChartPaper measures.
    const inks = [...paper.querySelectorAll(".stamp-ink")].filter((s) => getComputedStyle(s).visibility !== "hidden");
    stamp = inks.map((s) => {
      const r = s.getBoundingClientRect();
      const shown = Math.max(0, Math.min(r.right, pr.right - 34) - Math.max(r.left, pr.left));
      return { left: Math.round(r.left - pr.left), width: Math.round(r.width), onPaper: +(shown / r.width).toFixed(2) };
    });
  }
  const paperBox = paper ? box(paper) : null;

  return {
    vw, vh, docHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth,
    pageRunsOffSide: document.documentElement.scrollWidth > vw + 1,
    offside: offside.slice(0, 12), cut: cut.slice(0, 12), overlaps: overlaps.slice(0, 20),
    smallTargets: small.slice(0, 20), smallTargetCount: small.length, under44Count: under44.length, under44: under44.slice(0, 8),
    tinyText: Object.fromEntries(tiny), paper: paperBox, paperTopInViewport: paperBox ? paperBox.y - sy : null, stamp,
  };
}

// ---- Run --------------------------------------------------------------------------
let server = null;
let base = remote;
if (!base) {
  // --dist: another build folder (say, the full build with live mode, not the demo).
  const dist = opt("--dist", null);
  server = await preview({ root: dashboard, logLevel: "silent", build: dist ? { outDir: resolve(dist) } : undefined, preview: { port: 4175, strictPort: false, host: "127.0.0.1" } });
  base = server.resolvedUrls.local[0];
}
if (!base.endsWith("/")) base += "/";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const problems = [];
const results = { base: remote ?? "a local copy of the demo build", checked_at: new Date().toISOString(), moments: {} };
const frames = (page, n = 3) => page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

async function open(size, url) {
  const { label, ...ctx } = SIZES[size];
  const context = await browser.newContext({ ...ctx, reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`${size} ${url}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`${size} ${url}: ${m.text()}`));
  page.on("response", (r) => r.status() >= 400 && problems.push(`${size} ${url}: ${r.status()} for ${r.url()}`));
  await page.goto(base + url, { waitUntil: "networkidle" });
  return { context, page };
}

try {
  if (sweep) {
    // The menu at every width from 1000 to 1700 px: do the menu, the wordmark and the
    // controls overlap or run off the side?
    const rows = [];
    for (const screen of ["", "#/report", "#/lineup"]) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      const page = await context.newPage();
      await page.goto(base + (screen ? screen : "?paused"), { waitUntil: "networkidle" });
      if (screen) await page.waitForSelector("main[data-ready]");
      else await page.waitForFunction(() => window.polygraph?.ready);
      for (let w = 1000; w <= 1700; w += 10) {
        await page.setViewportSize({ width: w, height: 800 });
        await frames(page, 2);
        const r = await page.evaluate(() => {
          const header = document.querySelector("header");
          if (!header) return null;
          const parts = [...header.querySelectorAll("a, button, select")].filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden");
          const hits = [];
          for (let i = 0; i < parts.length; i++)
            for (let j = i + 1; j < parts.length; j++) {
              const a = parts[i].getBoundingClientRect();
              const b = parts[j].getBoundingClientRect();
              const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (w > 1 && h > 1) hits.push(`${(parts[i].textContent || parts[i].getAttribute("aria-label") || "").trim().slice(0, 14)} × ${(parts[j].textContent || parts[j].getAttribute("aria-label") || "").trim().slice(0, 14)} (${Math.round(w)} px)`);
            }
          const hr = header.getBoundingClientRect();
          return { headerHeight: Math.round(hr.height), runsOff: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, hits };
        });
        rows.push({ screen: screen || "replay", width: w, ...r });
      }
      await context.close();
    }
    results.menuSweep = rows;
    const bad = rows.filter((r) => r.hits?.length || r.runsOff);
    console.log(`menu sweep: ${bad.length} of ${rows.length} widths have an overlap or run off the side`);
    for (const r of bad) console.log(`  ${r.screen} ${r.width} px: ${r.hits.join("; ")}${r.runsOff ? " (page runs off the side)" : ""}`);
    writeFileSync(resolve(out, "menu-sweep.json"), JSON.stringify(rows, null, 2) + "\n");
  } else {
    for (const moment of MOMENTS) {
      if (only && !only.split(",").some((o) => moment.name.startsWith(o))) continue;
      for (const size of sizes) {
        const { context, page } = await open(size, moment.url);
        try {
          if (moment.ready) await page.waitForSelector("main[data-ready]", { timeout: 30000 });
          // The evidence wall adds its cards a few at a time (Session 11): wait for all of them.
          if (moment.ready && moment.url.includes("evidence")) await page.waitForSelector("[data-complete], [data-complete=''], main section h2", { timeout: 60000 }).catch(() => {});
          if (moment.wait) await page.waitForSelector(moment.wait, { timeout: 15000 });
          let stampCheck = null;
          if (moment.at || moment.act) await page.waitForFunction(() => window.polygraph?.ready);
          if (moment.at) {
            const { marks, duration } = await page.evaluate(() => ({ marks: window.polygraph.marks, duration: window.polygraph.duration }));
            await page.evaluate((x) => window.polygraph.seek(x), moment.at(marks, duration));
            if (moment.stampCheck) stampCheck = typeof moment.stampCheck === "function" ? moment.stampCheck(marks) : moment.stampCheck;
          }
          if (moment.act) await moment.act(page);
          await frames(page, 4);
          await page.waitForTimeout(400);
          const m = await page.evaluate(measure, { stampCheck });
          const file = `${size}-${moment.name}.jpg`;
          await page.screenshot({ path: resolve(out, file), type: "jpeg", quality });
          let fullFile = null;
          if (moment.full && SIZES[size].viewport.width < 1024) {
            fullFile = `${size}-${moment.name}-page.jpg`;
            const h = Math.min(m.docHeight, SIZES[size].viewport.height * 5);
            await page.screenshot({ path: resolve(out, fullFile), type: "jpeg", quality: quality - 10, fullPage: true, clip: { x: 0, y: 0, width: SIZES[size].viewport.width, height: h } });
          }
          results.moments[`${size} ${moment.name}`] = { size, moment: moment.name, note: moment.note, file, fullFile, ...m };
          const flags = [
            m.pageRunsOffSide && "RUNS OFF THE SIDE",
            m.offside.length && `${m.offside.length} off the side`,
            m.cut.length && `${m.cut.length} cut short`,
            m.overlaps.length && `${m.overlaps.length} overlaps`,
            m.smallTargetCount && `${m.smallTargetCount} targets < 24px`,
            Object.keys(m.tinyText).length && `text ${Object.keys(m.tinyText).join("/")}`,
            m.paperTopInViewport !== null && `paper at ${m.paperTopInViewport}px`,
            m.stamp && `stamp ${m.stamp.map((s) => `${Math.round(s.onPaper * 100)}% on paper`).join(", ") || "gone"}`,
          ].filter(Boolean);
          console.log(`${size.padEnd(8)} ${moment.name.padEnd(28)} ${flags.join(" · ") || "ok"}`);
        } catch (e) {
          problems.push(`${size} ${moment.name}: ${e.message.split("\n")[0]}`);
          console.log(`${size.padEnd(8)} ${moment.name.padEnd(28)} FAILED: ${e.message.split("\n")[0]}`);
        } finally {
          await context.close();
        }
      }
    }
  }
  results.problems = problems;
  writeFileSync(resolve(out, sweep ? "menu-sweep-checks.json" : "audit.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`browser errors and failed downloads: ${problems.length ? "\n  " + problems.join("\n  ") : "none"}`);
} finally {
  await browser.close();
  if (server) await new Promise((r) => server.httpServer.close(r));
}
