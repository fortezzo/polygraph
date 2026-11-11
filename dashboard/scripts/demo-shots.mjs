// Session 10: screenshots and checks of the demo site, at laptop and phone size.
//
// It checks the built demo (npm run build:demo first) on this PC, or the live
// site with --url. It uses the Microsoft Edge already on this PC, invisibly.
//
//   npm run build:demo && node scripts/demo-shots.mjs
//   node scripts/demo-shots.mjs --url https://example.github.io/polygraph/ --out <folder>
//   node scripts/demo-shots.mjs --only 04 --size phone --no-checks
//
// Checks: no errors in the browser, no failed downloads, the first page loads no
// recording, nothing jumps while a whole recording plays, the frame rate, an
// accessibility scan, the speed control, "Next caught answer", the strip's tabs,
// and that the demo has no live mode.

import { preview } from "vite";
import { chromium } from "playwright-core";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const out = resolve(opt("--out", resolve(dashboard, "..", "docs", "screenshots", "session-10")));
const only = opt("--only", null);
const onlySize = opt("--size", null);
const checks = !args.includes("--no-checks");
mkdirSync(out, { recursive: true });
if (!only && !onlySize) for (const f of readdirSync(out)) if (f.endsWith(".jpg")) rmSync(resolve(out, f));

const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const LLAMA = "2026-11-10_13-02-10_ollama_llama3.2";
const GEMMA3 = "2026-11-10_13-08-46_ollama_gemma3-12b";
const GEMMA4 = "2026-11-10_19-02-51_ollama_gemma4-12b";
const NEVER = "2026-11-10_13-05-55_ollama_llama3.2";

const mark = (marks, trap, name) => {
  const m = marks.find((x) => x.trap === trap && x.name === name);
  if (!m) throw new Error(`no mark ${trap} ${name}`);
  return m.t;
};
const firstCaught = (marks) => marks.find((m) => m.name === "stamp");

// Each moment: an address, then (for the replay) a time to show or something to click.
const MOMENTS = [
  { name: "01-highlights", note: "The first page: the Highlights (6 answers Christian checked by hand, graded by Claude Haiku 5.5), with the Recording picker, the speed control and Next caught answer.", url: "?paused", at: (m) => mark(m, "ghost-004", "stamp") + 700 },
  { name: "02-highlights-verdict", note: "The Highlights' new last answer, limits-002: it named a closing price for the S&P 500 next Friday, which nobody can know.", url: "?paused", at: (m) => mark(m, "limits-002", "final") + 1500 },
  { name: "03-recording", note: "A whole recording: all 200 of Llama 3.2's questions. The strip shows one trap type at a time, with the 8 types as tabs.", url: `?paused#/replay?run=${LLAMA}`, at: (m) => firstCaught(m).t + 700 },
  {
    name: "04-next-caught",
    note: "Next caught answer: from question 2 (honest), one click lands just before question 3's made-up words, which then stream in and spike the needle.",
    url: `?at=ghost-002#/replay?run=${LLAMA}`,
    act: async (page) => {
      await page.getByRole("button", { name: /Next caught/ }).click();
      const trap = await page.evaluate(() => {
        const p = window.polygraph;
        const now = p.now();
        return [...p.marks.filter((m) => m.name === "start")].reverse().find((m) => m.t <= now)?.trap;
      });
      await page.waitForFunction((id) => {
        const p = window.polygraph;
        const stamp = p.marks.find((m) => m.trap === id && m.name === "stamp");
        return !!stamp && p.now() > stamp.t + 600;
      }, trap, { timeout: 15000 });
      await page.evaluate(() => window.polygraph.pause());
    },
  },
  {
    name: "05-later-type",
    note: "Later in the same recording: a tab jumps to that trap type (here, consistency), and the boxes show each verdict so far.",
    url: `?paused#/replay?run=${LLAMA}`,
    at: (m) => {
      const c = m.filter((x) => x.trap.startsWith("consistency-") && x.name === "stamp");
      return (c[2] ?? c[0]).t + 900;
    },
  },
  {
    name: "06-speed",
    note: "The speed control at 8×: a whole interrogation takes about an hour at 1× and about 8 minutes at 8×.",
    url: `#/replay?run=${LLAMA}`,
    act: async (page) => {
      await page.getByRole("button", { name: "Play at 8 times speed" }).click();
      await page.waitForTimeout(2500);
    },
  },
  { name: "07-never-unsure", note: "Never Unsure (Llama 3.2 with its own instructions): the instructions are shown with every question, since it got them every time.", url: `?paused#/replay?run=${NEVER}`, at: (m) => firstCaught(m).t + 700 },
  { name: "08-empty-answer", note: "Gemma 4 on citation-004: it thought until it hit the length limit and never answered. The replay says so.", url: `?paused#/replay?run=${GEMMA4}`, at: (m) => mark(m, "citation-004", "final") + 900 },
  { name: "09-missing-recording", note: "An address for a recording that isn't on the site: a plain message, and the picker still works.", url: "#/replay?run=no-such-recording", wait: "text=That recording isn't here" },
  { name: "10-report", note: "The Report card opens on Claude Haiku 5.5's grade of Gemma 3 12B's 200-trap run: the bot in the Highlights.", url: "#/report", ready: true },
  { name: "11-evidence", note: "The Evidence wall opens on the same run. Christian's hand labels now show on its 50 reused answers.", url: "#/evidence", ready: true },
  { name: "12-confidence", note: "The Overconfidence meter opens on the same run, with the most confident lie Christian checked by hand.", url: "#/confidence", ready: true, fullPhone: true },
  { name: "13-second-opinion", note: "A second opinion stays reachable and says so: gpt-6-luna's grades of the same Gemma 3 answers, with a link to the lineup's.", url: `#/report?run=${GEMMA3}--gpt-6-luna`, ready: true },
  { name: "14-earlier-run", note: "An earlier 80-trap run stays reachable and says so, with a link to the bot's 200-trap run.", url: "#/report?run=2026-11-09_15-47-13_ollama_gemma3-12b", ready: true },
  { name: "15-replaced", note: "Qwen3.6's replaced grades say they don't count, with a link to the grades that do.", url: "#/report?run=2026-11-10_13-02-02_openai_gpt-6-luna--qwen3.6-35b", ready: true },
  { name: "16-lineup", note: "The lineup. The demo's menu has no New interrogation tab.", url: "#/lineup", ready: true },
  { name: "17-not-in-demo", note: "The New interrogation address explains that new interrogations run on the computer where Polygraph is installed.", url: "#/new", wait: "text=NOT IN THIS DEMO" },
];

let server = null;
let base = remote;
if (!base) {
  server = await preview({ root: dashboard, logLevel: "silent", preview: { port: 4174, strictPort: false, host: "127.0.0.1" } });
  base = server.resolvedUrls.local[0];
}
if (!base.endsWith("/")) base += "/";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const problems = [];
const shots = [];
const results = { base: remote ? base : "a local copy of the demo build", checked_at: new Date().toISOString() };

async function openAt(size, url, { reducedMotion, init } = {}) {
  const context = await browser.newContext({ ...SIZES[size], reducedMotion: reducedMotion ?? "no-preference" });
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`${size} ${url}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`${size} ${url}: ${m.text()}`));
  page.on("requestfailed", (r) => problems.push(`${size} ${url}: couldn't download ${r.url()} (${r.failure()?.errorText})`));
  page.on("response", (r) => r.status() >= 400 && problems.push(`${size} ${url}: ${r.status()} for ${r.url()}`));
  if (init) await page.addInitScript(init);
  await page.goto(base + url, { waitUntil: "networkidle" });
  return { context, page };
}

const frames = (page, n = 3) => page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

try {
  for (const moment of MOMENTS) {
    if (only && !moment.name.startsWith(only)) continue;
    for (const size of Object.keys(SIZES)) {
      if (onlySize && size !== onlySize) continue;
      const { context, page } = await openAt(size, moment.url);
      if (moment.ready) await page.waitForSelector("main[data-ready]");
      if (moment.wait) await page.waitForSelector(moment.wait);
      if (moment.at || moment.act) await page.waitForFunction(() => window.polygraph?.ready);
      if (moment.at) {
        const { marks, duration } = await page.evaluate(() => ({ marks: window.polygraph.marks, duration: window.polygraph.duration }));
        await page.evaluate((x) => window.polygraph.seek(x), moment.at(marks, duration));
      }
      if (moment.act) await moment.act(page);
      await frames(page, 4);
      await page.waitForTimeout(500);
      const file = `${size}-${moment.name}.jpg`;
      await page.screenshot({ path: resolve(out, file), type: "jpeg", quality: 82 });
      shots.push({ file, size, name: moment.name, note: moment.note });
      if (size === "phone" && moment.fullPhone) {
        const full = `${size}-${moment.name}-full-page.jpg`;
        await page.screenshot({ path: resolve(out, full), type: "jpeg", quality: 78, fullPage: true });
        shots.push({ file: full, size, name: `${moment.name} (whole page)`, note: `${moment.note} The whole phone page, scrolled.` });
      }
      console.log(`shot ${file} (${(statSync(resolve(out, file)).size / 1024).toFixed(0)} KB)`);
      await context.close();
    }
  }

  if (checks) {
    // 1. The first page: what it downloads. No recording until one is picked.
    for (const size of Object.keys(SIZES)) {
      const context = await browser.newContext({ ...SIZES[size] });
      const page = await context.newPage();
      const got = [];
      page.on("response", async (r) => {
        const body = await r.body().catch(() => null);
        got.push({ url: r.url().replace(base, ""), status: r.status(), bytes: Number(r.headers()["content-length"] ?? body?.length ?? 0), encoding: r.headers()["content-encoding"] ?? null });
      });
      await page.goto(base, { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.polygraph?.ready);
      await page.waitForTimeout(800);
      const runs = got.filter((g) => g.url.startsWith("runs/"));
      results[`firstPage_${size}`] = {
        files: got.length,
        bytes: got.reduce((n, g) => n + g.bytes, 0),
        runs: runs.map((g) => g.url),
        recordingsLoaded: runs.filter((g) => !/runs\/replays\.json$/.test(g.url)).length,
      };
      const f = results[`firstPage_${size}`];
      console.log(`first page (${size}): ${f.files} files, ${(f.bytes / 1024).toFixed(0)} KB as sent; from runs/: ${f.runs.join(", ") || "nothing"}; recordings loaded: ${f.recordingsLoaded}`);
      await context.close();
    }

    // 2. What the pickers offer, word for word.
    {
      const { context, page } = await openAt("desktop", "");
      await page.waitForFunction(() => window.polygraph?.ready);
      await page.waitForFunction(() => document.querySelectorAll("select option").length > 1);
      results.recordingPicker = await page.evaluate(() => [...document.querySelector("select").querySelectorAll("option")].map((o) => ({ value: o.value, label: o.textContent, group: o.parentElement?.tagName === "OPTGROUP" ? o.parentElement.label : null, selected: o.selected })));
      await context.close();
      const data = await openAt("desktop", "#/report");
      await data.page.waitForSelector("main[data-ready]");
      results.subjectPicker = await data.page.evaluate(() => [...document.querySelector("select").querySelectorAll("option")].map((o) => ({ value: o.value, label: o.textContent, group: o.parentElement?.label ?? null, selected: o.selected })));
      results.reportOpensOn = results.subjectPicker.find((o) => o.selected);
      for (const s of ["#/evidence", "#/confidence"]) {
        await data.page.goto(base + s, { waitUntil: "networkidle" });
        await data.page.waitForSelector("main[data-ready]");
        results[`${s.slice(2)}OpensOn`] = await data.page.evaluate(() => document.querySelector("select").selectedOptions[0]?.textContent);
      }
      await data.context.close();
      console.log(`the report card opens on: ${results.reportOpensOn?.label}; evidence: ${results.evidenceOpensOn}; overconfidence: ${results.confidenceOpensOn}`);
      console.log(`recording picker: ${results.recordingPicker.map((o) => o.label).join(" | ")}`);
    }

    // 3. Nothing jumps while a whole recording plays: 40 seconds at 8×, both sizes.
    for (const size of Object.keys(SIZES)) {
      const { context, page } = await openAt(size, `#/replay?run=${LLAMA}`);
      await page.waitForFunction(() => window.polygraph?.ready);
      await page.getByRole("button", { name: "Play at 8 times speed" }).click();
      const r = await page.evaluate(() => new Promise((done) => {
        let total = 0;
        const entries = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.hadRecentInput) continue;
            total += e.value;
            if (e.value < 0.0001) continue;
            entries.push({ value: +e.value.toFixed(4), at: Math.round(window.polygraph.now()), moved: (e.sources ?? []).slice(0, 3).map((s) => `${s.node?.nodeName ?? "?"} "${(s.node?.textContent ?? "").trim().slice(0, 30)}" y ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)}`) });
          }
        }).observe({ type: "layout-shift" });
        setTimeout(() => done({ total, entries, played: Math.round(window.polygraph.now()), rate: window.polygraph.rate() }), 40000);
      }));
      results[`layoutShift_${size}_recording`] = r;
      console.log(`layout shift (${size}, whole recording at ${r.rate}×): ${r.total.toFixed(4)} over ${(r.played / 1000).toFixed(0)} s of replay`);
      for (const e of r.entries) console.log(`   ${e.value} at ${(e.at / 1000).toFixed(1)} s: ${e.moved.join(" | ")}`);
      await context.close();
    }

    // 4. Nothing jumps as the data screens open on their defaults.
    for (const size of Object.keys(SIZES)) {
      for (const url of ["#/report", "#/evidence", "#/confidence", `#/report?run=${GEMMA3}--gpt-6-luna`]) {
        const { context, page } = await openAt(size, url, {
          init: () => {
            window.__shift = 0;
            new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!e.hadRecentInput) window.__shift += e.value; })).observe({ type: "layout-shift", buffered: true });
          },
        });
        await page.waitForSelector("main[data-ready]");
        await page.waitForTimeout(1000);
        const shift = await page.evaluate(() => window.__shift);
        results[`layoutShift_${size}_${url}`] = shift;
        console.log(`layout shift (${size}, ${url}): ${shift.toFixed(4)} while it opened`);
        await context.close();
      }
    }

    // 5. Frame rate: 6 seconds of a whole recording at 1×, the needle scrolling (uncapped).
    {
      const { context, page } = await openAt("desktop", `?paused#/replay?run=${LLAMA}`);
      await page.waitForFunction(() => window.polygraph?.ready);
      const t = await page.evaluate(() => window.polygraph.marks.find((m) => m.name === "answer" && m.trap.startsWith("consistency-")).t);
      results.frames = await page.evaluate((start) => new Promise((done) => {
        window.polygraph.seek(start);
        window.polygraph.play();
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
            done({ frames: gaps.length, fps: Math.round(gaps.length / ((now - t0) / 1000)), p95: +pct(0.95).toFixed(2), p99: +pct(0.99).toFixed(2), worst: +gaps[gaps.length - 1].toFixed(2) });
          }
        };
        requestAnimationFrame(f);
      }), t);
      console.log(`frames (whole recording): ${results.frames.fps} a second uncapped; 99% under ${results.frames.p99} ms (60 fps needs 16.7 ms)`);
      await context.close();
    }

    // 6. The controls do what they say.
    {
      const { context, page } = await openAt("desktop", `#/replay?run=${LLAMA}`);
      await page.waitForFunction(() => window.polygraph?.ready);
      const at = () => page.evaluate(() => window.polygraph.now());
      const a = await at();
      await page.waitForTimeout(2000);
      const b = await at();
      await page.getByRole("button", { name: "Play at 4 times speed" }).click();
      const c = await at();
      await page.waitForTimeout(2000);
      const d = await at();
      const pressed = await page.getByRole("button", { name: "Play at 4 times speed" }).getAttribute("aria-pressed");
      await page.getByRole("button", { name: "Play at 1 times speed" }).click();
      // Next caught answer, three times: each lands on a caught question, just before its made-up words.
      const hops = [];
      for (let i = 0; i < 3; i++) {
        await page.getByRole("button", { name: /Next caught/ }).click();
        hops.push(await page.evaluate(() => {
          const p = window.polygraph;
          const now = p.now();
          const starts = p.marks.filter((m) => m.name === "start");
          const trap = [...starts].reverse().find((m) => m.t <= now)?.trap;
          const spike = p.marks.find((m) => m.trap === trap && (m.name === "spike" || m.name === "stamp"));
          return { trap, now: Math.round(now), madeUpWordsIn: spike ? Math.round(spike.t - now) : null };
        }));
      }
      // A tab jumps to its trap type's first question.
      await page.getByRole("button", { name: /^Numbers: Number traps, 25 questions/ }).click();
      const tab = await page.evaluate(() => {
        const p = window.polygraph;
        const now = p.now();
        return [...p.marks.filter((m) => m.name === "start")].reverse().find((m) => m.t <= now)?.trap;
      });
      results.controls = {
        normalSpeed: Math.round((b - a) / 2000 * 10) / 10,
        fourTimes: Math.round((d - c) / 2000 * 10) / 10,
        fourPressed: pressed,
        nextCaught: hops,
        numberTab: tab,
        newTab: await page.getByRole("link", { name: /New/ }).count(),
      };
      console.log(`speed: ${results.controls.normalSpeed}× then ${results.controls.fourTimes}× (pressed: ${pressed}); next caught: ${hops.map((h) => `${h.trap} (made-up words in ${(h.madeUpWordsIn / 1000).toFixed(1)} s)`).join(", ")}; the Number traps tab went to ${tab}; New tabs: ${results.controls.newTab}`);
      await context.close();
    }

    // 7. Accessibility scan (WCAG 2.1 AA) on the new screens and states.
    results.axe = {};
    const SCANS = [
      { url: "?paused", seek: (m) => m.find((x) => x.trap === "ghost-004" && x.name === "final").t + 1500 },
      { url: `?paused#/replay?run=${LLAMA}`, seek: (m) => m.find((x) => x.name === "final" && x.trap.startsWith("premise-")).t + 1500 },
      { url: `?paused#/replay?run=${NEVER}`, seek: (m) => m.find((x) => x.name === "final").t + 1500 },
      { url: "#/replay?run=no-such-recording", wait: "text=That recording isn't here" },
      { url: "#/report", ready: true },
      { url: "#/evidence", ready: true },
      { url: "#/confidence", ready: true },
      { url: `#/report?run=${GEMMA3}--gpt-6-luna`, ready: true },
      { url: "#/report?run=2026-11-09_15-47-13_ollama_gemma3-12b", ready: true },
      { url: "#/new", wait: "text=NOT IN THIS DEMO" },
    ];
    for (const size of Object.keys(SIZES)) {
      for (const s of SCANS) {
        const { context, page } = await openAt(size, s.url);
        if (s.ready) await page.waitForSelector("main[data-ready]");
        if (s.wait) await page.waitForSelector(s.wait);
        if (s.seek) {
          await page.waitForFunction(() => window.polygraph?.ready);
          const marks = await page.evaluate(() => window.polygraph.marks);
          await page.evaluate((x) => window.polygraph.seek(x), s.seek(marks));
          await frames(page, 4);
        }
        const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        results.axe[`${size} ${s.url}`] = scan.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, first: v.nodes[0]?.target?.join(" ") }));
        console.log(`axe ${size} ${s.url}: ${scan.violations.length ? scan.violations.map((v) => `${v.id} (${v.nodes.length})`).join(", ") : "no problems"}`);
        await context.close();
      }
    }

    results.problems = problems;
    console.log(`browser errors and failed downloads: ${problems.length ? problems.join("\n  ") : "none"}`);
    writeFileSync(resolve(out, "checks.json"), JSON.stringify(results, null, 2) + "\n");
  }

  if (!only && !onlySize) {
    const names = [...new Set(shots.map((s) => s.name.replace(/ \(whole page\)$/, "")))];
    const rows = names.map((n) => {
      const d = shots.find((s) => s.size === "desktop" && s.name === n);
      const p = shots.find((s) => s.size === "phone" && s.name === n);
      const pf = shots.find((s) => s.size === "phone" && s.name === `${n} (whole page)`);
      const img = (s, label) => (s ? `<figure><a href="${s.file}" target="_blank"><img src="${s.file}" alt="${label}: ${s.note}" loading="lazy"></a><figcaption>${label}</figcaption></figure>` : "");
      return `<section><h2>${n.replace(/^\d+-/, "").replace(/-/g, " ")}</h2><p>${(d ?? p).note}</p><div class="row">${img(d, "Laptop, 1440 × 900")}${img(p, "Phone, 390 × 844")}${img(pf, "Phone, whole page")}</div></section>`;
    });
    writeFileSync(
      resolve(out, "index.html"),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo site screenshots</title>
<style>body{margin:0;background:#0d0c0b;color:#ece6da;font:16px/1.5 "Segoe UI",system-ui,sans-serif}.page{max-width:1300px;margin:0 auto;padding:32px 20px 80px}h1{font-size:28px;margin:0 0 6px}h2{font-size:20px;margin:0;text-transform:capitalize}section{margin:0 0 44px}p{color:#bdb5a8;margin:4px 0 12px}.row{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}figure{margin:0}.row figure:first-child{flex:1 1 640px}.row figure:not(:first-child){flex:0 0 220px}img{display:block;width:100%;border:1px solid rgba(255,255,255,.1);border-radius:6px}figcaption{font-size:13px;color:#a39b8d;margin-top:4px}</style></head>
<body><div class="page"><h1>The demo site: screenshots (Session 10)</h1><p>The demo build (npm run build:demo), checked at ${remote ? base : "a local copy"}: the replay of whole recordings, the speed control, Next caught answer, and what every screen opens on. Every screen at laptop and phone size. Click any screenshot to see it full size.</p>${rows.join("\n")}</div></body></html>\n`,
    );
  }
} finally {
  await browser.close();
  if (server) await new Promise((r) => server.httpServer.close(r));
}
