// A real end-to-end check of live mode (Session 8), run by hand: the real
// server and dashboard (start them first with .\start.ps1), Llama 3.2 on this
// PC, and the real gpt-6-luna judge. It drives the browser like a person would:
// one run of 10 know-your-limits traps, then a custom bot (Bob's Pizza bot) on
// 10 document traps. Each run saves files in runs/ and costs about 1 cent.
//   node scripts/real-live-check.mjs <screenshot folder>
import { chromium } from "playwright-core";
import { resolve } from "node:path";

const out = process.argv[2];
const base = "http://127.0.0.1:5173/";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

async function run(label, setup) {
  await page.goto(base + "#/new", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("aside dl", { timeout: 30000 });
  await page.selectOption("#bot", "ollama|llama3.2");
  await page.getByRole("button", { name: "None" }).click();
  await setup(page);
  await page.waitForFunction(() => /Traps\s*10, one at a time/i.test(document.querySelector("aside dl")?.textContent ?? ""), null, { timeout: 30000 });
  const plan = await page.locator("aside dl").innerText();
  console.log(`--- ${label}: the plan\n${plan}`);
  await page.getByRole("button", { name: "Start the interrogation" }).click();
  await page.waitForURL(/#\/live/, { timeout: 30000 });
  const started = Date.now();
  // Watch it until the screen shows the end.
  await page.waitForFunction(() => {
    const p = window.polygraph;
    const s = p?.state?.();
    return !!s?.finished && p.now() >= s.finished.at + 800;
  }, null, { timeout: 600000, polling: 500 });
  console.log(`${label}: over after ${((Date.now() - started) / 1000).toFixed(0)} s on screen`);
  const summary = await page.evaluate(() => {
    const s = window.polygraph.state();
    return {
      status: s.finished.status,
      stop_reason: s.finished.stop_reason,
      spent: s.finished.spent_usd,
      exported: s.finished.exported,
      run_id: s.finished.run_id,
      judged_file: s.finished.judged_file,
      verdicts: s.traps.map((t) => `${t.id}:${t.verdict?.verdict ?? t.verdict?.error ?? "none"}`),
      chunks: s.traps.reduce((n, t) => n + t.turns.reduce((m, u) => m + u.pieces.length, 0), 0),
      saved: s.traps.reduce((n, t) => n + t.turns.filter((u) => u.saved).length, 0),
      errors: s.errors,
    };
  });
  console.log(JSON.stringify(summary, null, 1));
  await page.screenshot({ path: resolve(out, `real-${label}-live.jpg`), type: "jpeg", quality: 85 });
  await page.getByRole("link", { name: "Report card →" }).click();
  await page.waitForSelector("main[data-ready]", { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(out, `real-${label}-report.jpg`), type: "jpeg", quality: 85, fullPage: true });
  const fine = await page.locator("footer").innerText();
  console.log(`${label}: the report card's fine print\n${fine}`);
}

try {
  await run("llama", async (p) => {
    await p.getByRole("checkbox", { name: /Know your limits/ }).check();
  });
  await run("bob", async (p) => {
    await p.getByLabel(/Test your own bot/).check();
    await p.getByLabel("Its name").fill("Bob's Pizza bot");
    await p.getByLabel("Its instructions").fill(
      "You are the support bot for Bob's Pizza in Brambleford. We're open 11am to 10pm every day and deliver within 3 miles. Our crusts are hand-stretched every morning. Be friendly and brief.",
    );
    await p.getByRole("checkbox", { name: /Stick to the document/ }).check();
  });
} finally {
  console.log(`console errors: ${errors.length ? errors.join("\n  ") : "none"}`);
  await browser.close();
}
