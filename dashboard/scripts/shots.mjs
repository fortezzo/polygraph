// Screenshots of every screen at laptop and phone sizes, plus the automatic
// checks: nothing jumps while answers stream in, the frame rate, an
// accessibility scan, sound off by default, and reduced motion. Live mode
// (Session 8) is in live-shots.mjs: it runs Polygraph's server in pretend mode.
//
// Uses the built app (npm run shots builds it first) and the Microsoft Edge
// already installed on this PC, running invisibly.
//
//   npm run shots                                   everything, into docs/screenshots/session-9
//   node scripts/shots.mjs --only 03 --size desktop --out <folder> --no-checks

import { preview } from "vite";
import { chromium } from "playwright-core";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, writeFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_MOMENTS, LIVE_PORT, liveShots, startLiveServers } from "./live-shots.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const out = resolve(opt("--out", resolve(dashboard, "..", "docs", "screenshots", "session-9")));
const only = opt("--only", null);
const onlySize = opt("--size", null);
const checks = !args.includes("--no-checks");
mkdirSync(out, { recursive: true });
// A full run starts clean, so no screenshot of an older build is left behind.
if (!only && !onlySize) for (const f of readdirSync(out)) if (f.endsWith(".jpg")) rmSync(resolve(out, f));

const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const GEMMA = "2026-11-09_15-47-13_ollama_gemma3-12b";
const LLAMA = "2026-11-08_21-51-00_ollama_llama3.2";

const mark = (marks, trap, name) => {
  const m = marks.find((x) => x.trap === trap && x.name === name);
  if (!m) throw new Error(`no mark ${trap} ${name}`);
  return m.t;
};

// Each moment is a time in the replay (or a whole other screen), with a note on what it shows.
const MOMENTS = [
  { name: "01-question-typing", note: "The question types itself out. The needle is quiet while the bot waits.", at: (m) => mark(m, "ghost-004", "question") + 1600 },
  { name: "02-answer-streaming", note: "An answer streams in. The needle is calm: nothing made up yet.", at: (m) => mark(m, "limits-002", "answer") + 1100 },
  { name: "03-caught-spike", note: "The made-up words just streamed in: the needle spikes red and the stamp has landed.", at: (m) => mark(m, "ghost-004", "stamp") + 700 },
  { name: "04-caught-verdict", note: "The verdict is in: LIE, 98% sure, with the truth and its source.", at: (m) => mark(m, "ghost-004", "final") + 1500 },
  { name: "05-honest", note: "An honest answer: no spike, no stamp, a ✓ HONEST label and a tick on the paper.", at: (m) => mark(m, "number-005", "final") + 900 },
  { name: "06-four-chats", note: "A consistency trap: the same question asked 4 ways, each in a new chat.", at: (m) => mark(m, "consistency-003", "final") - 3200 },
  { name: "07-caved", note: "It caved under pressure: an amber spike that droops, CAUGHT and ↓ CAVED.", at: (m) => mark(m, "pressure-002", "final") + 900 },
  { name: "08-document", note: "A document trap: the document is handed over as an exhibit, then the question types out.", at: (m) => mark(m, "document-004", "question") + 700 },
  { name: "09-replay-over", note: "The end: every verdict on the strip of questions, and a tally. Each stamp sits on its own spike.", at: (_m, d) => d },
  {
    name: "10-name-hidden",
    // Session 10: limits-005 left the Highlights, so this shows Llama's made-up references instead.
    note: "Christian's rule: the authors Llama 3.2 credited with made-up references are shown as [name hidden]. The run file keeps the original.",
    url: "?paused#/replay?run=2026-11-10_13-02-10_ollama_llama3.2",
    replay: true,
    at: (m) => mark(m, "citation-001", "final") + 1500,
    // Scroll the transcript to the made-up study.
    after: (page) => page.evaluate(() => {
      const el = document.querySelector(".name-hidden");
      const box = el?.closest(".transcript-box");
      if (el && box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight * 0.35;
    }),
  },
  { name: "11-reduced-motion", note: "With reduce motion on: the paper stays still and the pen draws across it, the stamp fades in.", at: (m) => mark(m, "ghost-004", "final") + 1500, reducedMotion: "reduce" },
  { name: "12-loading", note: "Loading.", url: "?state=loading" },
  { name: "13-empty", note: "Empty: a recording with no questions in it.", url: "?state=empty" },
  { name: "14-error", note: "Error: a file that isn't a Polygraph run file.", url: "?state=error" },
  // Session 7: the report card, the evidence wall and the overconfidence meter, with real runs.
  { name: "15-report", note: "Report card, Gemma 3 12B: Truth Score, grade, verdicts, the short verdict, the radar and the fine print.", url: `#/report?run=${GEMMA}`, ready: true, fullPhone: true },
  { name: "16-report-llama", note: "Report card, Llama 3.2 3B.", url: `#/report?run=${LLAMA}`, ready: true },
  { name: "17-evidence", note: "Evidence wall, Gemma 3 12B: every caught answer, with filters.", url: `#/evidence?run=${GEMMA}`, ready: true },
  { name: "18-evidence-citations", note: "Fake citations only: each reference marked made up or real paper, wrong details, with names hidden.", url: `#/evidence?run=${GEMMA}&type=fake_citation`, ready: true },
  { name: "19-evidence-consistency", note: "Llama's contradictions: four chats per card, the contradicting answer marked.", url: `#/evidence?run=${LLAMA}&type=consistency`, ready: true },
  { name: "20-evidence-disagree", note: "A card where Christian's hand label disagrees with Polygraph (Llama, document-009).", url: `#/evidence?run=${LLAMA}&trap=document-009`, ready: true, fullPhone: true },
  { name: "21-confidence", note: "Overconfidence meter, Gemma 3 12B, with the most confident lie checked by hand.", url: `#/confidence?run=${GEMMA}`, ready: true, fullPhone: true },
  { name: "22-confidence-llama", note: "Llama 3.2 3B, with its 27 misread-looking readings flagged.", url: `#/confidence?run=${LLAMA}`, ready: true },
  { name: "23-confidence-llama-clean", note: "The same, with the misread-looking readings left out.", url: `#/confidence?run=${LLAMA}&readings=clean`, ready: true },
  { name: "24-data-loading", note: "Loading a case file.", url: `?state=loading#/report?run=${GEMMA}` },
  { name: "25-data-empty", note: "No judged runs yet.", url: `?state=empty#/report?run=${GEMMA}` },
  { name: "26-data-error", note: "A run file that couldn't be loaded, with Try again.", url: `?state=error#/report?run=${GEMMA}` },
  { name: "27-evidence-no-matches", note: "Filters that match nothing (Gemma has no dodges).", url: `#/evidence?run=${GEMMA}&verdict=DODGED`, ready: true },
  // Session 9: the lineup. Take these once every lineup run is in and judged.
  // Numbered after Session 8's live mode (28 to 38, in live-shots.mjs).
  { name: "39-lineup", note: "The lineup: every bot against the height chart, its placard below, then the judges and the side-by-sides.", url: "#/lineup", ready: true, fullPhone: true },
  { name: "40-lineup-judge", note: "A placard's judge link opens that judge's card: Claude Haiku 5.5, with the same numbers as every judge and Christian's spot check.", url: "#/lineup?judge=claude-haiku-5-5", ready: true },
  { name: "41-lineup-loading", note: "Loading the lineup.", url: "?state=loading#/lineup" },
  { name: "42-lineup-empty", note: "No lineup yet.", url: "?state=empty#/lineup" },
  { name: "43-lineup-error", note: "The lineup couldn't be loaded, with Try again.", url: "?state=error#/lineup" },
  { name: "44-lineup-replaced", note: "The judge that was replaced: Qwen3.6 35B's card, stamped REPLACED, with its numbers kept.", url: "#/lineup?judge=qwen3.6:35b", ready: true },
  { name: "45-report-replaced", note: "A report card graded by the replaced judge says plainly that its grades don't count.", url: "#/report?run=2026-11-10_13-02-02_openai_gpt-6-luna--qwen3.6-35b", ready: true },
];

// Live mode needs Polygraph's server (in pretend mode), reached through the preview at /api.
const wantLive = !only || LIVE_MOMENTS.some((m) => m.name.startsWith(only));
const live = wantLive ? await startLiveServers() : null;
const server = await preview({
  root: dashboard,
  logLevel: "silent",
  preview: { port: 4173, strictPort: false, host: "127.0.0.1", proxy: { "/api": { target: `http://127.0.0.1:${LIVE_PORT}`, changeOrigin: true } } },
});
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: "msedge", headless: true });
const consoleErrors = [];
const shots = [];

async function openAt(size, url, reducedMotion) {
  const context = await browser.newContext({ ...SIZES[size], reducedMotion: reducedMotion ?? "no-preference" });
  const page = await context.newPage();
  page.on("pageerror", (e) => consoleErrors.push(`${size} ${url}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${size} ${url}: ${m.text()}`));
  await page.goto(base + url, { waitUntil: "networkidle" });
  return { context, page };
}

const frames = (page, n = 3) => page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const results = {};

try {
  for (const moment of MOMENTS) {
    if (only && !moment.name.startsWith(only)) continue;
    for (const size of Object.keys(SIZES)) {
      if (onlySize && size !== onlySize) continue;
      const { context, page } = await openAt(size, moment.url ?? "?paused", moment.reducedMotion);
      if (moment.ready) await page.waitForSelector("main[data-ready]");
      if (!moment.url || moment.replay) {
        await page.waitForFunction(() => window.polygraph?.ready);
        const { marks, duration } = await page.evaluate(() => ({ marks: window.polygraph.marks, duration: window.polygraph.duration }));
        const t = moment.at(marks, duration);
        await page.evaluate((x) => window.polygraph.seek(x), t);
      }
      await frames(page, 4);
      if (moment.after) {
        await page.waitForTimeout(400); // let the transcript finish its own scrolling first
        await moment.after(page);
        await frames(page, 2);
      }
      await page.waitForTimeout(350); // let the stamp and fades settle
      const file = `${size}-${moment.name}.jpg`;
      await page.screenshot({ path: resolve(out, file), type: "jpeg", quality: 86 });
      shots.push({ file, size, name: moment.name, note: moment.note });
      if (size === "phone" && (moment.fullPhone || moment.name === "04-caught-verdict" || moment.name === "07-caved")) {
        const full = `${size}-${moment.name}-full-page.jpg`;
        await page.screenshot({ path: resolve(out, full), type: "jpeg", quality: 82, fullPage: true });
        shots.push({ file: full, size, name: `${moment.name} (whole page)`, note: `${moment.note} The whole phone page, scrolled.` });
      }
      console.log(`shot ${file} (${(statSync(resolve(out, file)).size / 1024).toFixed(0)} KB)`);
      await context.close();
    }
  }

  // Session 8: live mode, with the server in pretend mode.
  if (live) await liveShots({ browser, base, out, SIZES, shots, results, consoleErrors, only, onlySize, checks, scratch: live.scratch });

  if (checks) {
    // 1. Nothing jumps: add up every layout shift over the whole replay, played 4 times as fast.
    for (const size of Object.keys(SIZES)) {
      const { context, page } = await openAt(size, "?rate=4");
      await page.waitForFunction(() => window.polygraph?.ready);
      const r = await page.evaluate(() => new Promise((done) => {
        let total = 0;
        const entries = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.hadRecentInput) continue;
            total += e.value;
            if (e.value < 0.0001) continue; // sub-pixel nudges of invisible text, too small to see
            const what = (n) => !n ? "(removed)" : n.nodeType === 3 ? `text "${n.textContent.slice(0, 24)}"` : `${n.tagName.toLowerCase()}.${String(n.className?.baseVal ?? n.className ?? "").split(" ").slice(0, 2).join(".")} "${(n.textContent ?? "").trim().slice(0, 24)}"`;
            entries.push({
              value: +e.value.toFixed(4),
              at: Math.round(window.polygraph.now()),
              moved: (e.sources ?? []).slice(0, 3).map((s) => `${what(s.node)} y ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} x ${Math.round(s.previousRect.x)}→${Math.round(s.currentRect.x)}`),
            });
          }
        }).observe({ type: "layout-shift" });
        const wait = () => (window.polygraph.status() === "ended" ? done({ total, entries, played: Math.round(window.polygraph.now()) }) : setTimeout(wait, 250));
        wait();
      }));
      results[`layoutShift_${size}`] = r;
      console.log(`layout shift (${size}): ${r.total.toFixed(4)} over ${(r.played / 1000).toFixed(0)} s of replay`);
      for (const e of r.entries) console.log(`   ${e.value} at ${(e.at / 1000).toFixed(1)} s: ${e.moved.join(" | ")}`);
      await context.close();
    }

    // 1b. Nothing jumps on the Session 7 screens either: from opening until a second after they're ready.
    for (const size of Object.keys(SIZES)) {
      for (const url of [`#/report?run=${GEMMA}`, `#/evidence?run=${GEMMA}`, `#/confidence?run=${LLAMA}`, "#/lineup"]) {
        const context = await browser.newContext({ ...SIZES[size] });
        const page = await context.newPage();
        await page.addInitScript(() => {
          window.__shift = 0;
          new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!e.hadRecentInput) window.__shift += e.value; })).observe({ type: "layout-shift", buffered: true });
        });
        await page.goto(base + url, { waitUntil: "networkidle" });
        await page.waitForSelector("main[data-ready]");
        await page.waitForTimeout(1000);
        const shift = await page.evaluate(() => window.__shift);
        results[`layoutShift_${size}_${url.split("?")[0].slice(2)}`] = shift;
        console.log(`layout shift (${size}, ${url.split("?")[0]}): ${shift.toFixed(4)} while it opened`);
        await context.close();
      }
    }

    // 2. Frame rate: 6 seconds while the longest answer streams and the needle scrolls.
    //    The browser here has no 60 Hz cap, so this measures how much work each frame takes.
    {
      const { context, page } = await openAt("desktop", "?paused");
      await page.waitForFunction(() => window.polygraph?.ready);
      const t = await page.evaluate(() => window.polygraph.marks.find((m) => m.trap === "ghost-004" && m.name === "answer").t);
      const r = await page.evaluate((start) => new Promise((done) => {
        window.polygraph.seek(start);
        window.polygraph.play();
        const longTasks = [];
        try { new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(Math.round(e.duration)))).observe({ type: "longtask" }); } catch {}
        const gaps = [];
        let last = performance.now();
        const t0 = last;
        const f = (now) => {
          gaps.push(now - last);
          last = now;
          if (now - t0 < 6000) requestAnimationFrame(f);
          else {
            gaps.sort((a, b) => a - b);
            const pct = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
            done({ frames: gaps.length, fps: +(gaps.length / ((now - t0) / 1000)).toFixed(0), p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), p99: +pct(0.99).toFixed(2), worst: +gaps[gaps.length - 1].toFixed(2), longTasks });
          }
        };
        requestAnimationFrame(f);
      }), t);
      results.frames = r;
      console.log(`frames: ${r.fps} a second uncapped; 95% of frames under ${r.p95} ms, 99% under ${r.p99} ms (60 fps needs 16.7 ms); long tasks: ${r.longTasks.length}`);
      await context.close();
    }

    // 3. Accessibility scan (WCAG 2.1 AA rules) on the caught moment, both sizes, the
    //    three states, and every Session 7 screen.
    results.axe ??= {};
    const DATA = [
      `#/report?run=${GEMMA}`, `#/evidence?run=${GEMMA}`, `#/evidence?run=${GEMMA}&type=fake_citation`,
      `#/confidence?run=${GEMMA}`, `#/confidence?run=${LLAMA}`, `#/evidence?run=${GEMMA}&verdict=DODGED`,
      `?state=error#/report?run=${GEMMA}`,
      "#/lineup", "?state=error#/lineup",
    ];
    for (const size of Object.keys(SIZES)) {
      for (const url of ["?paused&scan", "?state=loading", "?state=empty", "?state=error", ...DATA]) {
        const { context, page } = await openAt(size, url);
        if (url.includes("#/") && !url.includes("state=")) await page.waitForSelector("main[data-ready]");
        if (url.startsWith("?paused")) {
          await page.waitForFunction(() => window.polygraph?.ready);
          await page.evaluate(() => window.polygraph.seek(window.polygraph.marks.find((m) => m.trap === "ghost-004" && m.name === "final").t + 1500));
          await frames(page, 4);
        }
        const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const key = `${size} ${url}`;
        results.axe[key] = scan.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, first: v.nodes[0]?.target?.join(" ") }));
        console.log(`axe ${key}: ${scan.violations.length ? scan.violations.map((v) => `${v.id} (${v.nodes.length})`).join(", ") : "no problems"}`);
        await context.close();
      }
    }

    // 4. Sound is off until the viewer turns it on, and nothing audio exists before that.
    {
      const { context, page } = await openAt("desktop", "");
      await page.waitForFunction(() => window.polygraph?.ready);
      const before = await page.evaluate(() => ({ on: window.polygraph.sound.enabled(), made: window.polygraph.sound.contextCreated() }));
      const button = page.getByRole("button", { name: /^Sound off$/ });
      const pressedBefore = await button.getAttribute("aria-pressed");
      await button.click();
      const after = await page.evaluate(() => ({ on: window.polygraph.sound.enabled(), made: window.polygraph.sound.contextCreated() }));
      const pressedAfter = await page.getByRole("button", { name: /^Sound on$/ }).getAttribute("aria-pressed");
      results.sound = { atLoad: before, ariaPressedAtLoad: pressedBefore, afterClick: after, ariaPressedAfterClick: pressedAfter };
      console.log(`sound at load: ${before.on ? "ON" : "off"}, audio created: ${before.made}; after clicking: ${after.on ? "on" : "OFF"}, audio created: ${after.made}`);
      await context.close();
    }

    // 5. Reduced motion: the paper doesn't scroll, and the grain doesn't flicker.
    {
      const { context, page } = await openAt("desktop", "", "reduce");
      await page.waitForFunction(() => window.polygraph?.ready);
      const read = () => page.evaluate(() => ({
        grid: document.querySelector(".paper-grid")?.style.transform ?? "",
        grain: getComputedStyle(document.querySelector(".grain")).animationName,
        motion: document.querySelector("[data-motion]")?.getAttribute("data-motion"),
        t: Math.round(window.polygraph.now()),
      }));
      const a = await read();
      await page.waitForTimeout(2500);
      const b = await read();
      const full = await openAt("desktop", "");
      await full.page.waitForFunction(() => window.polygraph?.ready);
      const g1 = await full.page.evaluate(() => document.querySelector(".paper-grid").style.transform);
      await full.page.waitForTimeout(700);
      const g2 = await full.page.evaluate(() => document.querySelector(".paper-grid").style.transform);
      await full.context.close();
      results.reducedMotion = { first: a, later: b, paperStill: a.grid === b.grid, normalPaperMoves: g1 !== g2 };
      console.log(`reduced motion: mode ${b.motion}; paper still: ${a.grid === b.grid} (${a.grid} → ${b.grid}); grain animation: ${b.grain}. Without it, the paper moves: ${g1 !== g2}`);
      await context.close();
    }
    results.consoleErrors = consoleErrors;
    console.log(`console errors: ${consoleErrors.length ? consoleErrors.join("\n  ") : "none"}`);
    writeFileSync(resolve(out, "checks.json"), JSON.stringify(results, null, 2) + "\n");
  }

  // A page to look at all the screenshots side by side.
  if (!only && !onlySize) {
    // In number order (the lineup's 39 on come after live mode's 28 to 38, though they're taken first).
    const num = (n) => Number(/^\d+/.exec(n)?.[0] ?? 0);
    const names = [...new Set(shots.map((s) => s.name.replace(/ \(whole page\)$/, "")))].sort((a, b) => num(a) - num(b));
    const rows = names.map((n) => {
      const d = shots.find((s) => s.size === "desktop" && s.name === n);
      const p = shots.find((s) => s.size === "phone" && s.name === n);
      const pf = shots.find((s) => s.size === "phone" && s.name === `${n} (whole page)`);
      const img = (s, label) => (s ? `<figure><a href="${s.file}" target="_blank"><img src="${s.file}" alt="${label}: ${s.note}" loading="lazy"></a><figcaption>${label}</figcaption></figure>` : "");
      return `<section><h2>${n.replace(/^\d+-/, "").replace(/-/g, " ")}</h2><p>${(d ?? p).note}</p><div class="row">${img(d, "Laptop, 1440 × 900")}${img(p, "Phone, 390 × 844")}${img(pf, "Phone, whole page")}</div></section>`;
    });
    writeFileSync(
      resolve(out, "index.html"),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dashboard screenshots</title>
<style>body{margin:0;background:#0d0c0b;color:#ece6da;font:16px/1.5 "Segoe UI",system-ui,sans-serif}.page{max-width:1300px;margin:0 auto;padding:32px 20px 80px}h1{font-size:28px;margin:0 0 6px}h2{font-size:20px;margin:0;text-transform:capitalize}section{margin:0 0 44px}p{color:#bdb5a8;margin:4px 0 12px}.row{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}figure{margin:0}.row figure:first-child{flex:1 1 640px}.row figure:not(:first-child){flex:0 0 220px}img{display:block;width:100%;border:1px solid rgba(255,255,255,.1);border-radius:6px}figcaption{font-size:13px;color:#a39b8d;margin-top:4px}</style></head>
<body><div class="page"><h1>The Polygraph dashboard: screenshots</h1><p>The interrogation room replays 6 real recorded answers from Gemma 3 12B. The report card, the evidence wall and the overconfidence meter show the real judged runs of Gemma 3 12B and Llama 3.2 3B. Live mode (28 to 38) runs Polygraph's server in pretend mode: its bot and judge replay the recorded Gemma 3 12B run at a realistic pace, so nothing real is asked or spent, and the screen says PRETEND. The lineup (from 39 on) shows the real judged runs of all 8 bots, graded by Claude Haiku 5.5. Every screen at laptop and phone size. Click any screenshot to see it full size.</p>${rows.join("\n")}</div></body></html>\n`,
    );
  }
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
  live?.stop();
}
