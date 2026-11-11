// Session 11: before-and-after screenshots of the biggest fixes, from two runs of
// scripts/polish-audit.mjs (the live demo before, the new build after), cropped and
// made small so the repo stays light. Writes docs/screenshots/session-11/index.html.
//
//   node scripts/before-after.mjs --before <audit folder> --after <audit folder>
//
// It also puts the Lighthouse numbers (lighthouse-before.json, lighthouse-after.json)
// and the sound measurements (sound-before.json, sound-after.json) on the page, when
// they're in the same folder.

import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const beforeDir = resolve(opt("--before", ""));
const afterDir = resolve(opt("--after", ""));
const out = resolve(opt("--out", resolve(here, "..", "..", "docs", "screenshots", "session-11")));
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith(".jpg")) rmSync(resolve(out, f));

// Each pair: a screenshot from both audits, an optional crop (in the screenshot's
// own pixels) and the width to show it at.
const PAIRS = [
  {
    name: "phone-spike",
    title: "On a phone, the spike and the CAUGHT stamp are still there when the verdict shows",
    note: "Christian's note from Session 7. Before: by the time the verdict and the confidence (98%) appeared, the red spike and the stamp had scrolled off the paper (3% of the stamp was left). After: the paper slows down after a stamp, just enough to keep it in view until the confidence has been up a while, then speeds back up.",
    file: "phone-05-highlights-verdict.jpg",
    crop: { x: 0, y: 0, w: 780, h: 1688 },
    width: 360,
  },
  {
    name: "phone-header",
    title: "On a phone, the chart is near the top, and nothing is cut short",
    note: "A whole recording (Llama 3.2). Before: six rows of controls came before the chart, which started 397 px down (478 px on a small phone); the menu cut off Lineup, and the picker cut its label short. After: the five tabs fit, the picker shows the bot's name with the exact tag in small print, and the strip of questions and the speed sit under the chart and the verdict. The chart starts at 208 px on both phone sizes.",
    file: "phone-10-recording.jpg",
    crop: { x: 0, y: 0, w: 780, h: 1688 },
    width: 360,
  },
  {
    name: "menu-overlap",
    title: "The menu no longer slides under the buttons on a narrow laptop window",
    note: "Christian's note from Session 9, at 1060 px wide. Before: from 1030 to 1110 px (1170 px with live mode's New tab) the Lineup tab sat under the Play button. After: below 1280 px the buttons show only their icons, with their words kept for screen readers and as tooltips.",
    file: "laptop-n-04-highlights-stamp.jpg",
    crop: { x: 0, y: 0, w: 1060, h: 240 },
    width: 760,
  },
  {
    name: "lineup-wall",
    title: "The lineup's placards line up, with friendly names",
    note: "Before: a maker line that wrapped (Microsoft · 14.7B, Mistral AI · 13.9B) pushed that bot's score lower, and claude-haiku-5-5 broke over three lines on every placard. After: friendly names with the exact tag in small print, the judge said once above the wall, and every score on the same line.",
    file: "laptop-31-lineup.jpg",
    crop: { x: 0, y: 0, w: 1440, h: 900 },
    width: 760,
  },
  {
    name: "lineup-phone",
    title: "The lineup on a phone takes two and a half screens instead of five",
    note: "Before: each bot was a tall placard with its bar underneath, about 520 px each. After: the name, the score and the grade side by side, the details on a line or two, and a slimmer bar.",
    file: "phone-31-lineup-page.jpg",
    crop: { x: 0, y: 900, w: 780, h: 2400 },
    width: 300,
  },
  {
    name: "report-phone",
    title: "The report card on a phone: the bot named once, and nothing jumps",
    note: "Before: the Subject picker sat in its own row under the wordmark, the bot was named again under the menu, and the page jumped 38 px when the picker arrived. After: one subject bar with the picker, its place held from the start.",
    file: "phone-19-report.jpg",
    crop: { x: 0, y: 0, w: 780, h: 1100 },
    width: 360,
  },
  {
    name: "confidence-axis",
    title: "The overconfidence chart's last label isn't cut off",
    note: "Before: on a phone, \"100%\" at the right end of the axis read \"100\". After: the chart leaves room for it, and its smallest numbers are a little bigger.",
    file: "phone-29-confidence-page.jpg",
    crop: { x: 0, y: 1500, w: 780, h: 420 },
    width: 390,
  },
  {
    name: "evidence-phone",
    title: "The evidence wall on a phone: the trap types are one row to swipe",
    note: "Before: four rows of trap-type buttons came before the first card. After: one row to swipe through, fading at the edge. The wall also opens much sooner (see Lighthouse below).",
    file: "phone-24-evidence.jpg",
    crop: { x: 0, y: 0, w: 780, h: 1688 },
    width: 360,
  },
];

const browser = await chromium.launch({ channel: "msedge", headless: true });
async function shrink(src, dest, crop, width) {
  const b64 = readFileSync(src).toString("base64");
  const scale = width / crop.w;
  const h = Math.round(crop.h * scale);
  const page = await browser.newPage({ viewport: { width, height: h }, deviceScaleFactor: 1 });
  await page.setContent(
    `<body style="margin:0;overflow:hidden;background:#0c0a08"><img src="data:image/jpeg;base64,${b64}" style="position:absolute;left:${-crop.x * scale}px;top:${-crop.y * scale}px;width:auto;transform-origin:0 0;transform:scale(${scale})"></body>`,
  );
  await page.waitForTimeout(100);
  await page.screenshot({ path: dest, type: "jpeg", quality: 74 });
  await page.close();
}

const made = [];
try {
  for (const p of PAIRS) {
    const files = {};
    for (const [side, dir] of [["before", beforeDir], ["after", afterDir]]) {
      const src = resolve(dir, p.file);
      if (!existsSync(src)) {
        console.log(`missing ${side}: ${src}`);
        continue;
      }
      const dest = `${p.name}-${side}.jpg`;
      await shrink(src, resolve(out, dest), p.crop, p.width);
      files[side] = dest;
    }
    made.push({ ...p, files });
    console.log(`${p.name}: ${Object.values(files).map((f) => `${f} (${(statSync(resolve(out, f)).size / 1024).toFixed(0)} KB)`).join(", ")}`);
  }
} finally {
  await browser.close();
}

// ---- Lighthouse and sound, if they're there ---------------------------------------------
const readJson = (f) => (existsSync(resolve(out, f)) ? JSON.parse(readFileSync(resolve(out, f), "utf8")) : null);
const lhBefore = readJson("lighthouse-before.json");
const lhAfter = readJson("lighthouse-after.json");
const CATS = [["performance", "Performance"], ["accessibility", "Accessibility"], ["best-practices", "Best Practices"], ["seo", "SEO"]];
function lighthouseTable(form) {
  if (!lhBefore || !lhAfter) return "";
  const pages = Object.values(lhAfter.pages).filter((p) => p.form === form);
  const rows = pages
    .map((a) => {
      const key = Object.keys(lhBefore.pages).find((k) => lhBefore.pages[k].page === a.page && lhBefore.pages[k].form === form);
      const b = key ? lhBefore.pages[key] : null;
      const cells = CATS.map(([k]) => {
        const was = b?.scores[k];
        const now = a.scores[k];
        const cls = now >= 90 ? "good" : now >= 50 ? "ok" : "bad";
        return `<td><span class="was">${was ?? "–"}</span> → <b class="${cls}">${now}</b></td>`;
      }).join("");
      return `<tr><th scope="row">${a.page}</th>${cells}<td class="small">${b ? `${(b.metrics.lcp_ms / 1000).toFixed(1)} s` : "–"} → ${(a.metrics.lcp_ms / 1000).toFixed(1)} s</td><td class="small">${b ? `${b.metrics.tbt_ms} ms` : "–"} → ${a.metrics.tbt_ms} ms</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th scope="col">${form === "mobile" ? "Phone settings" : "Laptop settings"}</th>${CATS.map(([, l]) => `<th scope="col">${l}</th>`).join("")}<th scope="col">Main content shows</th><th scope="col">Page frozen</th></tr></thead><tbody>${rows}</tbody></table>`;
}
const soundBefore = readJson("sound-before.json");
const soundAfter = readJson("sound-after.json");
function soundTable() {
  if (!soundBefore || !soundAfter) return "";
  const names = { thud: "The stamp's thud", "scratch-calm": "The scratch, needle calm", "scratch-spike": "The scratch, needle spiking" };
  const rows = Object.entries(names)
    .map(([k, label]) => {
      const b = soundBefore[k];
      const a = soundAfter[k];
      return `<tr><th scope="row">${label}</th><td>${b.peak_dbfs} → <b>${a.peak_dbfs}</b></td><td>${b.above_300hz_rms_dbfs} → <b>${a.above_300hz_rms_dbfs}</b></td><td>${b.under_150hz_percent}% → <b>${a.under_150hz_percent}%</b></td><td>${b.audible_ms} → <b>${a.audible_ms}</b> ms</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th scope="col">Sound</th><th scope="col">Loudest point (dBFS)</th><th scope="col">What a phone speaker can play (above 300 Hz, dBFS)</th><th scope="col">Energy under 150 Hz</th><th scope="col">Length</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const sections = made
  .map(
    (p) => `<section><h2>${p.title}</h2><p>${p.note}</p><div class="row">
  ${p.files.before ? `<figure><a href="${p.files.before}"><img src="${p.files.before}" alt="Before: ${p.title}" loading="lazy" style="max-width:${p.width}px"></a><figcaption>Before (the live demo, Nov 11)</figcaption></figure>` : ""}
  ${p.files.after ? `<figure><a href="${p.files.after}"><img src="${p.files.after}" alt="After: ${p.title}" loading="lazy" style="max-width:${p.width}px"></a><figcaption>After</figcaption></figure>` : ""}
  </div></section>`,
  )
  .join("\n");

writeFileSync(
  resolve(out, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Polish pass: before and after</title>
<style>body{margin:0;background:#0d0c0b;color:#ece6da;font:16px/1.5 "Segoe UI",system-ui,sans-serif}.page{max-width:1240px;margin:0 auto;padding:32px 20px 80px}h1{font-size:28px;margin:0 0 6px}h2{font-size:20px;margin:0 0 4px}section{margin:0 0 48px}p{color:#bdb5a8;margin:4px 0 12px;max-width:900px}.row{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}figure{margin:0}img{display:block;width:100%;border:1px solid rgba(255,255,255,.12);border-radius:6px}figcaption{font-size:13px;color:#a39b8d;margin-top:4px}table{border-collapse:collapse;margin:8px 0 20px;font-size:15px}th,td{border-bottom:1px solid rgba(255,255,255,.1);padding:6px 12px;text-align:left}td{white-space:nowrap}.was{color:#8d8577}.good{color:#4fd17f}.ok{color:#f5a524}.bad{color:#ff6a5a}.small{font-size:13px;color:#bdb5a8}</style></head>
<body><div class="page"><h1>The polish pass: before and after (Session 11)</h1>
<p>The biggest fixes, each as it looked on the live demo before the session and as it looks now. Click any screenshot to see it larger.</p>
${sections}
<section><h2>Speed: Lighthouse</h2><p>Google's page checker, imitating a mid-range phone on a slow connection (phone settings) and a laptop (laptop settings). Each number is the middle of three runs. Before is the live demo on Nov 11; after is ${lhAfter?.base ?? "the new build"}, which gave the same numbers as the live demo for the old build. "Page frozen" is Lighthouse's Total Blocking Time: how long the page couldn't respond while it loaded. On the evidence wall, Lighthouse used to count the filter buttons as the main content, which drew early while the page then froze for 1.7 seconds; now the first card is, and the page hardly freezes.</p>${lighthouseTable("mobile")}${lighthouseTable("desktop")}</section>
<section><h2>Sound</h2><p>Measured without speakers (scripts/sound-lab.mjs). Phone and laptop speakers play little under about 150 to 300 Hz, so the old thud was mostly a rumble they couldn't play. The new one is quieter at its loudest, shorter, and puts its sound where small speakers can play it. The scratch is near silent on the calm line and rises with the spike.</p>${soundTable()}</section>
</div></body></html>\n`,
);
console.log(`wrote ${resolve(out, "index.html")}`);
