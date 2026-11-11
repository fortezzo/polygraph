// Session 12: the README's GIF and screenshots, made from the demo build, so they show
// exactly what the demo shows. They go in docs/readme/.
//
//   npm run build:demo
//   node scripts/readme-media.mjs                 the GIF and the screenshots
//   node scripts/readme-media.mjs --gif           just the GIF
//   node scripts/readme-media.mjs --shots         just the screenshots
//   node scripts/readme-media.mjs --probe         print the GIF's moments and take test frames
//   node scripts/readme-media.mjs --gif --keep-frames   also save every 10th frame in .tools/gif/frames
//   node scripts/readme-media.mjs --debug-stamp   print the CAUGHT stamp's state, frame by frame
//
// It uses the Microsoft Edge already on this PC, invisibly, like the other screenshot
// scripts. The GIF needs two small libraries that aren't part of the dashboard. They're
// installed for this project only, in .tools/gif (git ignores .tools/). On a fresh copy,
// from the Polygraph folder:
//
//   mkdir .tools\gif; cd .tools\gif; npm init -y
//   npm install gifenc@1.0.3 pngjs@7.0.0 --before=2026-10-28T00:00:00Z --ignore-scripts --save-exact
//   cd ..\..
//
// How the GIF is made: the replay is recorded frame by frame on a controlled clock
// (Playwright's clock), so it plays at exactly the demo's speed however long each
// screenshot takes. The film grain and the typing caret are CSS animations that run on
// the real clock, so they're held still while it records; the grain is left out, to
// keep the file small. Each frame keeps only the 16-pixel blocks that changed (the rest
// are transparent), and the replay plays at the demo's own 2× speed (the speed control
// shows it), which keeps the GIF under 5 MB: 7.8 seconds, then 2.4 on the last frame.

import { preview } from "vite";
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = resolve(here, "..");
const root = resolve(dashboard, "..");
const out = resolve(root, "docs", "readme");
const args = process.argv.slice(2);
const want = (flag) => args.includes(flag);
const diagnosing = want("--probe") || want("--debug-stamp");
const doGif = want("--gif") || (!want("--shots") && !diagnosing);
const doShots = want("--shots") || (!want("--gif") && !diagnosing);
mkdirSync(out, { recursive: true });

if (!existsSync(resolve(dashboard, "dist", "index.html"))) {
  console.error("Build the demo first: npm run build:demo");
  process.exit(1);
}

// ---- The GIF's moment ----------------------------------------------------------------
// The Highlights' ghost-004: Gemma 3 12B asked about an Agatha Christie novel that
// doesn't exist. Christian labeled this answer a lie by hand (Session 5), and Claude
// Haiku 5.5 calls it a Lie with all 3 votes. It's 98% sure.
const GIF = {
  trap: "ghost-004",
  viewport: { width: 1280, height: 800 },
  scale: Number(process.env.GIF_SCALE ?? 0.78125), // 1280 × 800 drawn at 1000 × 625
  frameMs: Number(process.env.GIF_FRAME_MS ?? 100), // 10 frames a second
  // Where the GIF starts and ends, in ms of the replay around the moment's marks: just
  // before the question types itself out, to a while after the confidence shows.
  from: { mark: process.env.GIF_FROM_MARK ?? "question", offset: Number(process.env.GIF_FROM_MS ?? -300) },
  to: { mark: "final", offset: Number(process.env.GIF_TO_MS ?? 2000) },
  colors: Number(process.env.GIF_COLORS ?? 255),
  block: Number(process.env.GIF_BLOCK ?? 16), // changes are written in blocks of this many pixels square
  rate: Number(process.env.GIF_RATE ?? 2), // the replay's speed: 2× halves the frames, and the speed control shows it
  hold: 2400, // how long the last frame stays before the GIF starts again
  file: process.env.GIF_FILE ?? "interrogation.gif",
};
const STILL = `
  .grain { display: none !important; animation: none !important; }
  .caret::after { animation: none !important; }
`;

const server = await preview({ root: dashboard, logLevel: "silent", preview: { port: 4176, strictPort: false, host: "127.0.0.1" } });
const base = server.resolvedUrls.local[0].replace(/\/?$/, "/");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const problems = [];

function watch(page, label) {
  page.on("pageerror", (e) => problems.push(`${label}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`${label}: ${m.text()}`));
  page.on("requestfailed", (r) => problems.push(`${label}: couldn't download ${r.url()}`));
}

async function openReplay({ viewport, scale, url, still = true, fakeClock = true, isMobile = false }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, isMobile, hasTouch: isMobile, reducedMotion: "no-preference" });
  const page = await context.newPage();
  watch(page, url);
  if (fakeClock) {
    await page.clock.install({ time: new Date("2026-11-11T12:00:00Z") });
    // Motion hands opacity and scale to the browser's own animations (WAAPI), which run
    // on the real clock and so never move while the page's clock is stepped. Without
    // Element.animate, Motion runs the same springs itself, on the stepped clock. Only
    // in this recording page; the app is unchanged.
    await page.addInitScript(() => {
      delete Element.prototype.animate;
    });
  }
  if (still) {
    await page.addInitScript((css) => {
      document.addEventListener("DOMContentLoaded", () => {
        const s = document.createElement("style");
        s.textContent = css;
        document.head.append(s);
      });
    }, STILL);
  }
  await page.goto(base + url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.polygraph?.ready);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

const marksFor = (page, trap) => page.evaluate((id) => window.polygraph.marks.filter((m) => m.trap === id), trap);

// ---- Probe: the moments, and a few test frames ---------------------------------------
if (want("--probe")) {
  const { context, page } = await openReplay({ ...GIF, url: `?paused&at=${GIF.trap}` });
  const marks = await marksFor(page, GIF.trap);
  console.log(`${GIF.trap} marks:`, marks.map((m) => `${m.name}@${Math.round(m.t)}`).join("  "));
  const t = (name) => marks.find((m) => m.name === name)?.t;
  for (const [label, at] of [["typing", t("start") + 900], ["stamp", t("stamp") + 400], ["final", t("final") + 1500]]) {
    if (at === undefined || Number.isNaN(at)) continue;
    await page.evaluate((x) => window.polygraph.seek(x), at);
    await page.clock.runFor(200);
    const file = resolve(root, ".tools", "gif", `probe-${label}.png`);
    await page.screenshot({ path: file });
    console.log(`probe frame ${label} at ${Math.round(at)} ms -> ${file}`);
  }
  await context.close();
}

// ---- Debug: what the stamp element is doing around the moment it lands ---------------
if (want("--debug-stamp")) {
  const { context, page } = await openReplay({ ...GIF, url: `?paused&at=${GIF.trap}` });
  const marks = await marksFor(page, GIF.trap);
  const stampAt = marks.find((m) => m.name === "stamp").t;
  await page.clock.pauseAt(new Date("2026-11-11T12:10:00Z"));
  await page.evaluate((x) => {
    window.polygraph.seek(x);
    window.polygraph.play();
  }, stampAt - 240);
  for (let i = 0; i < 12; i++) {
    await page.clock.runFor(GIF.frameMs);
    const state = await page.evaluate(() => ({
      now: Math.round(window.polygraph.now()),
      perf: Math.round(performance.now()),
      stamps: [...document.querySelectorAll(".paper .stamp-ink")].map((el) => {
        const holder = el.parentElement;
        const cs = getComputedStyle(el);
        return { holderVis: holder.style.visibility, holderTf: holder.style.transform, opacity: cs.opacity, tf: cs.transform.slice(0, 40) };
      }),
    }));
    console.log(JSON.stringify(state));
  }
  await context.close();
}

// ---- The GIF -------------------------------------------------------------------------
if (doGif) {
  const requireTools = createRequire(resolve(root, ".tools", "gif", "package.json"));
  let gifenc, PNG;
  try {
    gifenc = requireTools("gifenc");
    ({ PNG } = requireTools("pngjs"));
  } catch {
    console.error("The GIF needs gifenc and pngjs in .tools/gif. See the top of this script for the install line.");
    process.exit(1);
  }
  const { GIFEncoder, quantize, applyPalette } = gifenc;

  const { context, page } = await openReplay({ ...GIF, url: `?paused&at=${GIF.trap}` });
  const marks = await marksFor(page, GIF.trap);
  const t = (name) => {
    const m = marks.find((x) => x.name === name);
    if (!m) throw new Error(`no ${name} mark for ${GIF.trap}`);
    return m.t;
  };
  const from = t(GIF.from.mark) + GIF.from.offset;
  const to = t(GIF.to.mark) + GIF.to.offset;

  // Stop the page's clock, start the replay just before the question, at the GIF's speed
  // (with the demo's own speed control, so the GIF shows which speed it plays at), then
  // step it one frame at a time.
  await page.clock.pauseAt(new Date("2026-11-11T12:10:00Z"));
  if (GIF.rate !== 1) {
    await page.getByRole("button", { name: `Play at ${GIF.rate} times speed` }).click();
    // Move the pointer off the button (no hover look), and let the page show the new speed.
    await page.mouse.move(640, 790);
    await page.waitForFunction((r) => window.polygraph.rate() === r, GIF.rate);
    await page.waitForTimeout(150);
  }
  await page.evaluate((x) => {
    window.polygraph.seek(x);
    window.polygraph.play();
  }, from);
  await page.clock.runFor(GIF.frameMs);
  await page.waitForTimeout(150);

  const shots = [];
  for (let at = from; at <= to; at += GIF.frameMs * GIF.rate) {
    shots.push(await page.screenshot({ type: "png" }));
    await page.clock.runFor(GIF.frameMs);
  }
  const played = await page.evaluate(() => window.polygraph.now());
  await context.close();
  console.log(`recorded ${shots.length} frames at ${GIF.rate}×: ${(shots.length * GIF.frameMs / 1000).toFixed(1)} s of GIF, ${(shots.length * GIF.frameMs * GIF.rate / 1000).toFixed(1)} s of replay (the replay clock ended at ${Math.round(played)} ms)`);
  if (want("--keep-frames")) {
    // Every 10th frame as a PNG, to look at (in .tools/gif/frames, which git ignores).
    const dir = resolve(root, ".tools", "gif", "frames");
    mkdirSync(dir, { recursive: true });
    shots.forEach((png, i) => (i % 10 === 0 || i === shots.length - 1) && writeFileSync(resolve(dir, `frame-${String(i).padStart(3, "0")}-${Math.round(from + i * GIF.frameMs * GIF.rate)}ms.png`), png));
  }

  // One palette for every frame, from a sample of all of them, so colors never flicker.
  const decode = (buf) => PNG.sync.read(buf);
  const first = decode(shots[0]);
  const { width, height } = first;
  const pick = shots.filter((_, i) => i % 6 === 0).map(decode);
  const sample = new Uint8Array(pick.length * width * height * 4);
  pick.forEach((p, i) => sample.set(p.data, i * width * height * 4));
  const colors = quantize(sample, Math.min(255, GIF.colors), { format: "rgb565" });
  const TRANSPARENT = colors.length; // one spare slot after the real colors
  const palette = [...colors, [0, 0, 0]];
  while (palette.length < 256) palette.push([0, 0, 0]);

  const gif = GIFEncoder();
  let shown = null; // the picture on screen so far, as palette indexes
  let pending = null; // a frame waiting for its delay (identical frames add to it)
  const flush = () => {
    if (!pending) return;
    const opts = pending.first
      ? { palette, delay: pending.delay, repeat: 0 }
      : { delay: pending.delay, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 };
    gif.writeFrame(pending.index, width, height, opts);
    pending = null;
  };
  let changedPixels = 0;
  for (let i = 0; i < shots.length; i++) {
    const { data } = i === 0 ? first : decode(shots[i]);
    const index = applyPalette(data, colors, "rgb565");
    if (!shown) {
      shown = index;
      pending = { index, delay: GIF.frameMs, first: true };
      continue;
    }
    // Which blocks changed. A block that changed at all is written whole; the others
    // are transparent. (Pixel by pixel, the scrolling paper leaves a speckle of pixels
    // that happen to match, which compresses badly.)
    const B = GIF.block;
    const cols = Math.ceil(width / B);
    const rows = Math.ceil(height / B);
    const dirty = new Uint8Array(cols * rows);
    let changed = 0;
    for (let p = 0; p < index.length; p++) {
      if (index[p] !== shown[p]) {
        dirty[Math.floor(p / width / B) * cols + Math.floor((p % width) / B)] = 1;
        changed++;
      }
    }
    const frame = new Uint8Array(index.length).fill(TRANSPARENT);
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        if (!dirty[by * cols + bx]) continue;
        for (let y = by * B; y < Math.min(height, (by + 1) * B); y++) {
          const row = y * width;
          for (let x = bx * B; x < Math.min(width, (bx + 1) * B); x++) {
            frame[row + x] = index[row + x];
            shown[row + x] = index[row + x];
          }
        }
      }
    }
    if (changed === 0) {
      pending.delay += GIF.frameMs;
      continue;
    }
    changedPixels += changed;
    flush();
    pending = { index: frame, delay: GIF.frameMs, first: false };
  }
  pending.delay += GIF.hold;
  flush();
  gif.finish();
  const bytes = gif.bytes();
  writeFileSync(resolve(out, GIF.file), bytes);
  console.log(`wrote docs/readme/${GIF.file}: ${width} × ${height}, ${(bytes.length / 1024 / 1024).toFixed(2)} MB, ${colors.length} colors, ${(changedPixels / (shots.length - 1) / (width * height) * 100).toFixed(1)}% of pixels change per frame on average`);
}

// ---- The screenshots -----------------------------------------------------------------
if (doShots) {
  const SHOTS = [
    { file: "lineup.jpg", url: "#/lineup", viewport: { width: 1440, height: 1240 }, ready: true, height: 1178 }, // ends under the wall, before the notes
    { file: "report-card.jpg", url: "#/report", viewport: { width: 1440, height: 1000 }, ready: true, height: 978 }, // ends under the last trap type
    { file: "evidence-wall.jpg", url: "#/evidence", viewport: { width: 1440, height: 1000 }, ready: true },
    { file: "overconfidence.jpg", url: "#/confidence", viewport: { width: 1440, height: 1000 }, ready: true },
  ];
  for (const s of SHOTS) {
    const context = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: 1.25, reducedMotion: "no-preference" });
    const page = await context.newPage();
    watch(page, s.url);
    await page.addInitScript((css) => {
      document.addEventListener("DOMContentLoaded", () => {
        const st = document.createElement("style");
        st.textContent = css;
        document.head.append(st);
      });
    }, STILL);
    await page.goto(base + s.url, { waitUntil: "networkidle" });
    if (s.ready) await page.waitForSelector("main[data-ready]");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(out, s.file), type: "jpeg", quality: 82, clip: { x: 0, y: 0, width: s.viewport.width, height: s.height ?? s.viewport.height } });
    console.log(`shot docs/readme/${s.file} (${(statSync(resolve(out, s.file)).size / 1024).toFixed(0)} KB)`);
    await context.close();
  }

  // A phone, at the moment the verdict shows: the stamp is still on the paper (Session 11).
  {
    const { context, page } = await openReplay({ viewport: { width: 390, height: 844 }, scale: 2, isMobile: true, url: `?paused&at=${GIF.trap}`, fakeClock: false });
    const marks = await marksFor(page, GIF.trap);
    const final = marks.find((m) => m.name === "final").t;
    await page.evaluate((x) => window.polygraph.seek(x), final + 1200);
    await page.waitForTimeout(700);
    // Down to the speed control: the chart, the stamp, the verdict and the strip.
    await page.screenshot({ path: resolve(out, "phone.jpg"), type: "jpeg", quality: 82, clip: { x: 0, y: 0, width: 390, height: 692 } });
    console.log(`shot docs/readme/phone.jpg (${(statSync(resolve(out, "phone.jpg")).size / 1024).toFixed(0)} KB)`);
    await context.close();
  }
}

await browser.close();
await new Promise((r) => server.httpServer.close(r));
if (problems.length) {
  console.log(`\nBrowser problems (${problems.length}):`);
  for (const p of problems) console.log(`  ${p}`);
  process.exitCode = 1;
} else {
  console.log("\nNo browser errors.");
}
