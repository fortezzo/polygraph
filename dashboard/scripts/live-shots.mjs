// Session 8: screenshots and checks of live mode (the New interrogation screen
// and the live interrogation room), for scripts/shots.mjs.
//
// It runs Polygraph's server in pretend mode: the bot and the judge replay the
// recorded Gemma 3 12B run, word for word, at a realistic pace. Nothing real is
// asked, spent or saved (its files go in a throwaway folder). The screen says
// "PRETEND" on every live shot, so it can't be mistaken for a real run.

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { indexEntry, judgeCheck, trim } from "./export-runs.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PYTHON = resolve(ROOT, ".venv", "Scripts", "python.exe");
const RECORDED = resolve(ROOT, "runs", "2026-11-09_15-47-13_ollama_gemma3-12b_judged-by_gpt-6-luna~4.json");
export const LIVE_PORT = 8420;
const FAST_PORT = 8421;
const BOB = {
  name: "Bob's Pizza bot",
  instructions:
    "You are the support bot for Bob's Pizza in Brambleford. We're open 11am to 10pm every day and deliver within 3 miles. Our crusts are hand-stretched each morning. Be friendly and brief.",
};

export const LIVE_MOMENTS = [
  { name: "28-new-interrogation", note: "New interrogation: pick the bot, the judge and the traps, and see the plan and its cost before starting." },
  { name: "29-new-own-bot", note: "Test your own bot: a name and its instructions, run on the model picked above. The plan shows the cost." },
  { name: "30-new-server-down", note: "The server isn't running: a plain message with what to do (run .\\start.ps1)." },
  { name: "31-live-answering", note: "Live: the answer streams in as the bot writes it, and the status line says what's happening." },
  { name: "32-live-caught", note: "Live: the judge has ruled on ghost-004. The needle spikes at that moment, the CAUGHT stamp lands on the spike, and the made-up words light up." },
  { name: "33-live-finished", note: "Live: the run is over. The Truth Score and grade, how many were caught, and links to the full report." },
  { name: "34-live-saved-answer", note: "Christian's change: an answer reused from an earlier run says \"SAVED ANSWER FROM <date>\" and appears whole instead of streaming." },
  { name: "35-live-custom-bot", note: "Live, testing your own bot: its name and the model it runs on. Its first answer was honest: ✓ HONEST, a tick on the paper, no stamp." },
  { name: "36-live-stopped", note: "Stopped with the Stop button: what was finished is saved and judged." },
  { name: "37-report-custom-bot", note: "The report card of a custom bot that tested 2 trap types: its instructions, \"not tested\" for the other 6 types, and the note on the judge check." },
  { name: "38-live-nothing", note: "The live screen with no run going: where to start one." },
];

async function waitForHealth(port, child, label) {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`${label} stopped: ${child.stderrText}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} didn't start`);
}

function startPretend(port, extra = []) {
  const child = spawn(PYTHON, ["-m", "polygraph", "serve", "--pretend", RECORDED, "--port", String(port), ...extra], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderrText = "";
  child.stderr.on("data", (d) => (child.stderrText += d));
  return child;
}

const api = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(data)}`);
  return data;
};

/** Starts the pretend servers. Returns a function that stops them. */
export async function startLiveServers() {
  const scratch = mkdtempSync(join(tmpdir(), "polygraph-shots-"));
  const live = startPretend(LIVE_PORT);
  const fast = startPretend(FAST_PORT, ["--fast", "--pretend-folder", scratch]);
  await waitForHealth(LIVE_PORT, live, "The pretend server");
  await waitForHealth(FAST_PORT, fast, "The fast pretend server");
  return { scratch, stop: () => { live.kill(); fast.kill(); } };
}

/** A custom bot's judged run (pretend, fast), shaped like the dashboard's own copies. */
async function customBotRun(scratch) {
  await api(FAST_PORT, "/api/runs", { bot_provider: "ollama", bot_model: "gemma3:12b", types: ["ghost_fact", "know_your_limits"], own_bot: BOB, confirm: true });
  for (let i = 0; i < 240; i++) {
    const { run } = await api(FAST_PORT, "/api/runs/current");
    if (run?.state === "done") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const folder = join(scratch, "runs");
  const judged = readdirSync(folder).filter((f) => f.includes("_judged-by_")).sort().pop();
  const run = JSON.parse(readFileSync(join(folder, judged), "utf8"));
  const id = run.run.id;
  const slim = trim(run);
  const file = `${id}.json`;
  return { id, file, slim, entry: { ...indexEntry(slim, file, id, judged), judge_check: judgeCheck(run) } };
}

export async function liveShots({ browser, base, out, SIZES, shots, results, consoleErrors, only, onlySize, checks, scratch }) {
  const want = (name) => !only || name.startsWith(only);
  const sizes = Object.keys(SIZES).filter((s) => !onlySize || s === onlySize);
  const note = (name) => LIVE_MOMENTS.find((m) => m.name === name).note;

  async function open(size, hash, setup) {
    const context = await browser.newContext({ ...SIZES[size] });
    const page = await context.newPage();
    page.on("pageerror", (e) => consoleErrors.push(`${size} ${hash}: ${e.message}`));
    page.on("console", (m) => {
      // A deliberately refused request (the server-down shot) logs a network error; that's expected.
      if (m.type() === "error" && !(page.__offline && /Failed to load resource|ERR_FAILED/.test(m.text()))) consoleErrors.push(`${size} ${hash}: ${m.text()}`);
    });
    if (setup) await setup(page);
    await page.goto(base + hash, { waitUntil: "domcontentloaded" });
    return { context, page };
  }

  async function shoot(page, size, name, { full = false } = {}) {
    await page.waitForTimeout(300);
    const file = `${size}-${name}.jpg`;
    await page.screenshot({ path: resolve(out, file), type: "jpeg", quality: 86 });
    shots.push({ file, size, name, note: note(name) });
    if (full && size === "phone") {
      const whole = `${size}-${name}-full-page.jpg`;
      await page.screenshot({ path: resolve(out, whole), type: "jpeg", quality: 82, fullPage: true });
      shots.push({ file: whole, size, name: `${name} (whole page)`, note: `${note(name)} The whole phone page, scrolled.` });
    }
    console.log(`shot ${file} (${(statSync(resolve(out, file)).size / 1024).toFixed(0)} KB)`);
  }

  const planReady = (page) => page.waitForSelector("aside dl", { timeout: 20000 });
  const liveState = (page, test, arg, timeout = 120000) =>
    page.waitForFunction(
      ([source, a]) => {
        const p = window.polygraph;
        if (!p?.live) return false;
        // eslint-disable-next-line no-new-func
        return new Function("s", "now", "a", `return (${source})(s, now, a);`)(p.state(), p.now(), a);
      },
      [test.toString(), arg],
      { timeout, polling: 100 },
    );

  // --- The New interrogation screen -------------------------------------------------
  for (const size of sizes) {
    if (want("28-new-interrogation")) {
      const { context, page } = await open(size, "#/new");
      await planReady(page);
      await shoot(page, size, "28-new-interrogation", { full: true });
      await context.close();
    }
    if (want("29-new-own-bot")) {
      const { context, page } = await open(size, "#/new");
      await planReady(page);
      await page.getByLabel(/Test your own bot/).check();
      await page.getByLabel("Its name").fill(BOB.name);
      await page.getByLabel("Its instructions").fill(BOB.instructions);
      await page.getByRole("checkbox", { name: /Pressure test/ }).uncheck();
      await page.waitForFunction(() => document.querySelector("aside dl")?.textContent?.includes("Bob's Pizza bot"), null, { timeout: 20000 });
      if (size === "phone") await page.getByLabel("Its name").scrollIntoViewIfNeeded();
      await shoot(page, size, "29-new-own-bot", { full: true });
      await context.close();
    }
    if (want("30-new-server-down")) {
      const { context, page } = await open(size, "#/new", async (p) => {
        p.__offline = true;
        await p.route("**/api/**", (route) => route.abort());
      });
      await page.waitForSelector("text=Polygraph's server isn't running");
      await shoot(page, size, "30-new-server-down");
      await context.close();
    }
  }

  // --- A live run, watched at both sizes at once --------------------------------------
  // Opened the way "Start the interrogation" opens it: watching from the first question.
  const watch = async (hash = "#/live?from=start") => Promise.all(sizes.map(async (size) => ({ size, ...(await open(size, hash)) })));
  const all = (pages, fn) => Promise.all(pages.map(fn));
  const waitIdle = async () => {
    for (let i = 0; i < 240; i++) {
      const { run } = await api(LIVE_PORT, "/api/runs/current");
      if (!run || run.state === "done") return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("the pretend run didn't finish");
  };

  if (["31", "32", "33"].some((n) => want(n))) {
    await api(LIVE_PORT, "/api/runs", { bot_provider: "ollama", bot_model: "gemma3:12b", types: ["ghost_fact"], confirm: true });
    const pages = await watch();
    await all(pages, ({ page }) =>
      liveState(page, (s, now) => {
        const a = s.traps[0]?.turns.find((t) => t.role === "assistant");
        return !!a && !a.done && a.pieces.length > 6 && a.pieces[6].at < now;
      }),
    );
    if (want("31")) await all(pages, ({ page, size }) => shoot(page, size, "31-live-answering"));
    if ((checks || process.argv.includes("--live-shift")) && !results.liveShift) {
      // Nothing jumps while answers stream in, live: add up layout shifts over 8 seconds.
      results.liveShift = {};
      await all(pages, async ({ page, size }) => {
        const r = await page.evaluate(() => new Promise((done) => {
          let total = 0;
          const entries = [];
          // Session 11: a moved text also says which box it's in, so a move of the whole page and a move inside the transcript can be told apart.
          const box = (n) => { const e = n?.parentElement?.closest(".transcript-box, .area-summary, .area-details, .area-chart, .area-note, header, nav, main"); return e ? ` in ${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}` : ""; };
          const what = (n) => !n ? "(removed)" : n.nodeType === 3 ? `text "${n.textContent.slice(0, 24)}"${box(n)}` : `${n.tagName.toLowerCase()}.${String(n.className?.baseVal ?? n.className ?? "").split(" ").slice(0, 2).join(".")} "${(n.textContent ?? "").trim().slice(0, 30)}"`;
          new PerformanceObserver((l) => l.getEntries().forEach((e) => {
            if (e.hadRecentInput) return;
            total += e.value;
            if (e.value < 0.0001) return;
            // When it happened, against the trap on screen's milestones (live clock, ms).
            const p = window.polygraph;
            const s = p?.state?.();
            const t = s?.traps?.at(-1);
            const a = t?.turns?.filter((u) => u.role === "assistant").at(-1);
            const when = t ? `at ${Math.round(p.now())}: trap ${t.id} started ${Math.round(t.at)}, answer done ${Math.round(a?.doneAt ?? -1)}, confidence ${Math.round(a?.confidence?.at ?? -1)}, verdict ${Math.round(t.verdict?.at ?? -1)}` : "";
            entries.push({
              value: +e.value.toFixed(4),
              when,
              moved: (e.sources ?? []).slice(0, 5).map((s) => `${what(s.node)} y ${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} h ${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)}`),
            });
          })).observe({ type: "layout-shift" });
          setTimeout(() => done({ total, entries }), 8000);
        }));
        results.liveShift[size] = r;
        console.log(`layout shift (${size}, live, 8 s while answering): ${r.total.toFixed(4)}`);
        for (const e of r.entries) console.log(`   ${e.value} (${e.when}): ${e.moved.join(" | ")}`);
      });
    }
    await all(pages, ({ page }) => liveState(page, (s, now) => {
      const v = s.traps.find((t) => t.id === "ghost-004")?.verdict;
      return !!v && now > v.at + 900;
    }));
    if (want("32")) await all(pages, ({ page, size }) => shoot(page, size, "32-live-caught", { full: true }));
    if (checks) {
      results.axe ??= {};
      for (const { page, size } of pages) {
        const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        results.axe[`${size} #/live (caught)`] = scan.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, first: v.nodes[0]?.target?.join(" ") }));
        console.log(`axe ${size} #/live (caught): ${scan.violations.length ? scan.violations.map((v) => `${v.id} (${v.nodes.length})`).join(", ") : "no problems"}`);
      }
    }
    await all(pages, ({ page }) => liveState(page, (s, now) => !!s.finished && now > s.finished.at + 700, null, 240000));
    if (want("33")) await all(pages, ({ page, size }) => shoot(page, size, "33-live-finished", { full: true }));
    if (checks) {
      for (const { page, size } of pages) {
        const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        results.axe[`${size} #/live (finished)`] = scan.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, first: v.nodes[0]?.target?.join(" ") }));
        console.log(`axe ${size} #/live (finished): ${scan.violations.length ? scan.violations.map((v) => `${v.id} (${v.nodes.length})`).join(", ") : "no problems"}`);
      }
    }
    await all(pages, ({ context }) => context.close());
  }

  if (want("34")) {
    // The same traps again, reusing the saved answers.
    await waitIdle();
    await api(LIVE_PORT, "/api/runs", { bot_provider: "ollama", bot_model: "gemma3:12b", types: ["ghost_fact"], fresh: false, confirm: true });
    const pages = await watch();
    await all(pages, ({ page }) => liveState(page, (s, now) => {
      const a = s.traps[0]?.turns.find((t) => t.role === "assistant");
      return !!a && a.done && !!a.saved && !!a.confidence && a.confidence.at + 300 < now;
    }));
    await all(pages, ({ page, size }) => shoot(page, size, "34-live-saved-answer"));
    await api(LIVE_PORT, `/api/runs/${(await api(LIVE_PORT, "/api/runs/current")).run.id}/stop`, {});
    await all(pages, ({ context }) => context.close());
  }

  if (want("35") || want("36")) {
    await waitIdle();
    await api(LIVE_PORT, "/api/runs", { bot_provider: "ollama", bot_model: "gemma3:12b", types: ["know_your_limits"], own_bot: BOB, confirm: true });
    const pages = await watch();
    await all(pages, ({ page }) => liveState(page, (s, now) => {
      const t = s.traps[0];
      return !!t?.judging && t.judging.at <= now && (!t.verdict || t.verdict.at > now) && (t.turns.at(-1)?.confidence?.at ?? Infinity) <= now;
    }));
    if (want("35")) await all(pages, ({ page, size }) => shoot(page, size, "35-live-custom-bot"));
    await all(pages, ({ page }) => liveState(page, (s, now) => !!s.traps[1]?.verdict && now > s.traps[1].verdict.at + 300));
    // Press Stop, the way a person would.
    const first = pages[0].page;
    await first.getByRole("button", { name: /^Stop$/ }).click();
    await all(pages, ({ page }) => liveState(page, (s, now) => !!s.finished && now > s.finished.at + 600, null, 60000));
    if (want("36")) await all(pages, ({ page, size }) => shoot(page, size, "36-live-stopped"));
    await all(pages, ({ context }) => context.close());
  }

  if (want("37")) {
    const custom = await customBotRun(scratch);
    for (const size of sizes) {
      const { context, page } = await open(size, `#/report?run=${custom.id}`, async (p) => {
        await p.route("**/runs/index.json", async (route) => {
          const real = await (await route.fetch()).json();
          await route.fulfill({ json: { ...real, runs: [custom.entry, ...real.runs] } });
        });
        await p.route(`**/runs/${custom.file}`, (route) => route.fulfill({ json: custom.slim }));
      });
      await page.waitForSelector("main[data-ready]");
      await shoot(page, size, "37-report-custom-bot", { full: true });
      if (checks) {
        const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        results.axe[`${size} #/report (custom bot)`] = scan.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, first: v.nodes[0]?.target?.join(" ") }));
        console.log(`axe ${size} #/report (custom bot): ${scan.violations.length ? scan.violations.map((v) => `${v.id} (${v.nodes.length})`).join(", ") : "no problems"}`);
      }
      await context.close();
    }
  }

  if (want("38")) {
    for (const size of sizes) {
      const { context, page } = await open(size, "#/live", async (p) => {
        await p.route("**/api/runs/current", (route) => route.fulfill({ json: { run: null } }));
      });
      await page.waitForSelector("text=No interrogation is going right now");
      await shoot(page, size, "38-live-nothing");
      await context.close();
    }
  }

  // The New interrogation screen: accessibility and nothing jumping while it opens.
  if (checks) {
    results.axe ??= {};
    for (const size of sizes) {
      const { context, page } = await open(size, "#/new", (p) => p.addInitScript(() => {
        window.__shift = 0;
        new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (!e.hadRecentInput) window.__shift += e.value; })).observe({ type: "layout-shift", buffered: true });
      }));
      await planReady(page);
      await page.waitForTimeout(800);
      const shift = await page.evaluate(() => window.__shift);
      results[`layoutShift_${size}_new`] = shift;
      console.log(`layout shift (${size}, #/new): ${shift.toFixed(4)} while it opened and planned`);
      const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      results.axe[`${size} #/new`] = scan.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, first: v.nodes[0]?.target?.join(" ") }));
      console.log(`axe ${size} #/new: ${scan.violations.length ? scan.violations.map((v) => `${v.id} (${v.nodes.length})`).join(", ") : "no problems"}`);
      await context.close();
    }
  }
}
