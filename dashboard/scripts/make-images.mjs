// Session 11: the favicon set and the social preview picture, made from HTML in the
// dashboard's own fonts and look, and photographed with the Microsoft Edge already
// on this PC (invisibly). No new software.
//
//   node scripts/make-images.mjs                 everything, into public/ (the site) and docs/social/
//   node scripts/make-images.mjs --designs <dir> the two social preview designs to choose from
//
// The rules (Christian, Session 11): no company logos, and no names from the bots'
// answers. Model names appear only as plain text, as the site shows them.
//
// What it makes:
//   public/favicon.svg, public/favicon.ico (16, 32 and 48 px), public/apple-touch-icon.png (180 px)
//   public/social-preview.jpg (1200 × 630, for LinkedIn and the rest; index.html points to it)
//   ../docs/social/github-preview.jpg (1280 × 640, for the repo's own preview, uploaded by hand)

import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportRuns } from "./export-runs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const designsOut = opt("--designs", null);
const design = opt("--design", "A");

// ---- The fonts, embedded so the page needs nothing from the internet ------------------
const font = (pkg, file) => readFileSync(resolve(dashboard, "node_modules", "@fontsource", pkg, "files", file)).toString("base64");
const FONTS = `
@font-face { font-family: "Oswald"; font-weight: 600; src: url(data:font/woff2;base64,${font("oswald", "oswald-latin-600-normal.woff2")}) format("woff2"); }
@font-face { font-family: "Oswald"; font-weight: 700; src: url(data:font/woff2;base64,${font("oswald", "oswald-latin-700-normal.woff2")}) format("woff2"); }
@font-face { font-family: "Special Elite"; src: url(data:font/woff2;base64,${font("special-elite", "special-elite-latin-400-normal.woff2")}) format("woff2"); }
@font-face { font-family: "Courier Prime"; font-weight: 400; src: url(data:font/woff2;base64,${font("courier-prime", "courier-prime-latin-400-normal.woff2")}) format("woff2"); }
@font-face { font-family: "Courier Prime"; font-weight: 700; src: url(data:font/woff2;base64,${font("courier-prime", "courier-prime-latin-700-normal.woff2")}) format("woff2"); }
`;

// The same colors as src/index.css.
const C = { room: "#0c0a08", text: "#efe6d5", soft: "#dcd2bf", muted: "#a99c86", brass: "#d2aa6b", paper: "#ece2cb", paperInk: "#78321f", manila: "#dcbe82", manila2: "#d2b274", manilaInk: "#2a2015", stamp: "#c8271e", calm: "#1b6a3e", lie: "#c2241b" };

const STAMP_MASK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' seed='4'/%3E%3CfeColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.6 2.05'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

const BASE_CSS = `${FONTS}
* { box-sizing: border-box; margin: 0; }
html, body { width: 100%; height: 100%; }
body { background: ${C.room}; color: ${C.text}; font-family: "Courier Prime", monospace; overflow: hidden; position: relative; }
.lamp { position: absolute; inset: 0; background:
  radial-gradient(ellipse 60% 70% at 50% -10%, rgba(255,184,108,.34), rgba(255,166,86,.10) 45%, transparent 72%),
  radial-gradient(ellipse 120% 90% at 50% 40%, transparent 55%, rgba(0,0,0,.7) 100%); }
.grain { position: absolute; inset: 0; opacity: .09; mix-blend-mode: overlay; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 1.1 -0.1'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
.wordmark { font-family: "Oswald"; font-weight: 600; letter-spacing: .24em; color: #f3e8d2; }
.kicker { font-family: "Special Elite"; letter-spacing: .14em; color: ${C.brass}; }
.paper { position: relative; overflow: hidden; border-radius: 4px; background-color: ${C.paper}; box-shadow: 0 22px 50px rgba(0,0,0,.6);
  background-image: linear-gradient(rgba(150,62,44,.30) 1px, transparent 1px), linear-gradient(90deg, rgba(150,62,44,.30) 1px, transparent 1px),
    linear-gradient(rgba(150,62,44,.13) 1px, transparent 1px), linear-gradient(90deg, rgba(150,62,44,.13) 1px, transparent 1px);
  background-size: 48px 48px, 48px 48px, 9.6px 9.6px, 9.6px 9.6px; }
.paper::after { content: ""; position: absolute; inset: 0; background: radial-gradient(ellipse 60% 130% at 50% 0%, rgba(255,246,225,.5), transparent 70%), linear-gradient(90deg, rgba(60,35,10,.18), transparent 12%, transparent 88%, rgba(60,35,10,.18)); }
.holes { position: absolute; left: 0; right: 0; height: 16px; background: radial-gradient(circle at 12px 8px, ${C.room} 4px, transparent 4.6px) repeat-x; background-size: 24px 16px; z-index: 2; }
.stamp { position: absolute; z-index: 3; font-family: "Oswald"; font-weight: 700; line-height: 1; letter-spacing: .08em; color: ${C.stamp};
  border: 6px solid ${C.stamp}; border-radius: 8px; box-shadow: inset 0 0 0 4px ${C.paper}, inset 0 0 0 7px ${C.stamp}; mix-blend-mode: multiply;
  -webkit-mask-image: ${STAMP_MASK}; mask-image: ${STAMP_MASK}; }
`;

/** A needle trace: calm, then the made-up words spike it red, then calm again. */
function trace(width, height) {
  const mid = height / 2;
  const pts = [];
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let x = 18; x <= width * 0.47; x += 6) pts.push([x, mid + rand() * 12 + Math.sin(x / 37) * 5]);
  const calm1 = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const sx = width * 0.47;
  const spike = [[sx, mid], [sx + 16, mid - height * 0.36], [sx + 28, mid + height * 0.3], [sx + 42, mid - height * 0.42], [sx + 56, mid + height * 0.24], [sx + 70, mid - height * 0.2], [sx + 84, mid + height * 0.12], [sx + 98, mid]];
  const red = spike.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const pts2 = [];
  for (let x = sx + 98; x <= width * 0.86; x += 6) pts2.push([x, mid + rand() * 10 + Math.sin(x / 41) * 4]);
  const calm2 = pts2.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const pen = pts2[pts2.length - 1];
  return { calm1, red, calm2, pen, spikeX: sx + 49 };
}

function paperStrip({ width, height, stampSize }) {
  const t = trace(width, height);
  return `
  <div class="paper" style="width:${width}px;height:${height}px">
    <div class="holes" style="top:0"></div><div class="holes" style="bottom:0"></div>
    <svg width="${width}" height="${height}" style="position:absolute;inset:0;z-index:4" aria-hidden="true">
      <path d="${t.calm1}" fill="none" stroke="${C.calm}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${t.red}" fill="none" stroke="${C.lie}" stroke-width="3.6" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${t.calm2}" fill="none" stroke="${C.calm}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      <line x1="${t.pen[0]}" y1="${t.pen[1]}" x2="${width - 30}" y2="${height / 2}" stroke="#3a332b" stroke-width="3"/>
      <circle cx="${t.pen[0]}" cy="${t.pen[1]}" r="5" fill="${C.calm}"/>
      <path d="M${t.spikeX - 52} ${height - 38} v8 h104 v-8" fill="none" stroke="${C.lie}" stroke-width="2.2"/>
      <text x="${t.spikeX - 52}" y="${height - 14}" font-family="Special Elite" font-size="17" fill="${C.lie}">made-up words</text>
    </svg>
    <div style="position:absolute;right:10px;top:26px;bottom:26px;width:34px;border-radius:6px;background:linear-gradient(90deg,#2e2822,#221e19);box-shadow:inset 0 0 0 2px #4d453b;z-index:5"></div>
    <div class="stamp" style="left:${t.spikeX - stampSize * 2.1}px;top:${height / 2 - stampSize * 0.82}px;font-size:${stampSize}px;padding:${stampSize * 0.1}px ${stampSize * 0.28}px ${stampSize * 0.14}px;transform:rotate(-9deg)">CAUGHT</div>
  </div>`;
}

/** Design A: the machine. The wordmark, the strip of chart paper caught mid-lie, and what it is. */
function designA({ w, h, count, traps }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  .wrap { position: absolute; inset: 0; padding: 58px 64px; display: flex; flex-direction: column; }
  </style></head><body><div class="lamp"></div>
  <div class="wrap">
    <div class="wordmark" style="font-size:40px">POLYGRAPH</div>
    <div style="margin-top:14px;font-family:Oswald;font-weight:700;font-size:64px;line-height:1.02;color:#f3e8d2;letter-spacing:.01em">A lie detector for AI chatbots</div>
    <div style="margin-top:34px">${paperStrip({ width: w - 128, height: 230, stampSize: 54 })}</div>
    <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;gap:24px">
      <div style="font-size:27px;line-height:1.35;color:${C.soft}">${count} chatbots · the same ${traps} trap questions.<br><span style="color:${C.text};font-weight:700">Watch them get caught making things up.</span></div>
      <div class="kicker" style="font-size:20px;white-space:nowrap">RECORDED INTERROGATIONS</div>
    </div>
  </div><div class="grain"></div></body></html>`;
}

/** Design B: the lineup. Who was most honest, as the site ranks them. */
function designB({ w, h, bots, traps }) {
  const rows = bots
    .map(
      (b) => `<div style="display:grid;grid-template-columns:30px 196px 1fr 58px 40px;align-items:center;gap:14px;height:52px">
      <div style="font-family:'Special Elite';font-size:18px;color:${C.paperInk}">${b.place}</div>
      <div style="font-family:Oswald;font-weight:600;font-size:25px;color:${C.manilaInk};white-space:nowrap">${b.name}</div>
      <div style="position:relative;height:20px;background:rgba(42,32,21,.10);border-radius:3px"><div style="position:absolute;inset:0 auto 0 0;width:${b.score}%;background:${C.manilaInk};border-radius:0 3px 3px 0"></div></div>
      <div style="font-family:Oswald;font-weight:700;font-size:30px;color:${C.manilaInk};text-align:right">${b.score}</div>
      <div style="font-family:Oswald;font-weight:700;font-size:26px;color:${C.stamp};text-align:center;border:3px solid ${C.stamp};border-radius:5px;line-height:30px;transform:rotate(-6deg)">${b.grade}</div>
    </div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  .wrap { position: absolute; inset: 0; padding: 52px 60px; display: grid; grid-template-columns: 430px 1fr; gap: 44px; }
  .card { background: radial-gradient(ellipse at 30% 0%, rgba(255,240,200,.35), transparent 60%), linear-gradient(180deg, ${C.manila}, ${C.manila2}); border-radius: 6px; padding: 20px 26px; box-shadow: 0 22px 50px rgba(0,0,0,.6); display: flex; flex-direction: column; justify-content: space-between; }
  </style></head><body><div class="lamp"></div>
  <div class="wrap">
    <div style="display:flex;flex-direction:column">
      <div class="wordmark" style="font-size:38px">POLYGRAPH</div>
      <div style="margin-top:22px;font-family:Oswald;font-weight:700;font-size:58px;line-height:1.04;color:#f3e8d2">A lie detector for AI chatbots</div>
      <div style="margin-top:22px;font-size:25px;line-height:1.4;color:${C.soft}">${bots.length} chatbots, the same ${traps} trap questions. Ranked by how honest their answers were.</div>
      <div class="kicker" style="margin-top:auto;font-size:19px">TRUTH SCORE, OUT OF 100</div>
    </div>
    <div class="card">${rows}</div>
  </div><div class="grain"></div></body></html>`;
}

/** The favicon: chart paper with one red spike, bold enough to read at 16 px. */
function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="6" fill="${C.paper}" stroke="${C.paperInk}" stroke-width="2"/><path d="M4 19.5h7.5l3.2-12 4.2 17 2.9-8.5 1.6 3.5H28" fill="none" stroke="${C.lie}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/** An .ico holding PNGs (Windows and every browser read it). */
function ico(pngs) {
  const head = Buffer.alloc(6 + pngs.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

// ---- The data for the pictures: the lineup's grades, as the site shows them ------------
const { index } = exportRuns({ write: false, committedOnly: true });
const lineup = index.lineup;
// The friendly names, from the dashboard itself (Node reads the TypeScript file directly).
const { modelName: friendly } = await import(new URL("../src/lib/models.ts", import.meta.url).href);
const half = (v) => Math.round(v * 1 + Math.sign(v) * 1e-9); // halves up, like shownScore()
const scored = (lineup?.bots ?? []).filter((b) => b.state === "scored" && b.score).sort((a, b) => b.score.overall - a.score.overall);
let place = 0;
let last = null;
const bots = scored.map((b, i) => {
  const s = half(b.score.overall);
  if (s !== last) place = i + 1;
  last = s;
  return { name: friendly(b.model), score: s, grade: b.score.grade, place };
});
const traps = lineup?.traps ?? 200;

const browser = await chromium.launch({ channel: "msedge", headless: true });
async function shoot(html, w, h, path, transparent = false, jpeg = false) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const buf = await page.screenshot(jpeg ? { path, type: "jpeg", quality: 90 } : { path, type: "png", omitBackground: transparent });
  await page.close();
  return buf;
}

try {
  if (designsOut) {
    mkdirSync(designsOut, { recursive: true });
    await shoot(designA({ w: 1200, h: 630, count: bots.length, traps }), 1200, 630, resolve(designsOut, "social-A-the-machine.png"));
    await shoot(designB({ w: 1200, h: 630, bots, traps }), 1200, 630, resolve(designsOut, "social-B-the-lineup.png"));
    console.log(`two designs in ${designsOut}`);
  } else {
    const pub = resolve(dashboard, "public");
    const social = resolve(dashboard, "..", "docs", "social");
    mkdirSync(social, { recursive: true });
    const make = design === "B" ? (w, h) => designB({ w, h, bots, traps }) : (w, h) => designA({ w, h, count: bots.length, traps });
    await shoot(make(1200, 630), 1200, 630, resolve(pub, "social-preview.jpg"), false, true);
    await shoot(make(1280, 640), 1280, 640, resolve(social, "github-preview.jpg"), false, true);
    const svg = faviconSvg();
    writeFileSync(resolve(pub, "favicon.svg"), svg + "\n");
    const page = (size, pad, bg) =>
      `<!doctype html><html><body style="margin:0;background:${bg};width:${size}px;height:${size}px;display:grid;place-items:center">${svg.replace("<svg ", `<svg width="${size - pad * 2}" height="${size - pad * 2}" `)}</body></html>`;
    const pngs = [];
    for (const size of [16, 32, 48]) pngs.push({ size, data: await shoot(page(size, 0, "transparent"), size, size, undefined, true) });
    writeFileSync(resolve(pub, "favicon.ico"), ico(pngs));
    // iPhones show the home-screen icon on its own square: the room's color behind the paper.
    await shoot(page(180, 22, C.room), 180, 180, resolve(pub, "apple-touch-icon.png"));
    console.log(`made public/favicon.svg, favicon.ico, apple-touch-icon.png, social-preview.jpg (design ${design}) and docs/social/github-preview.jpg`);
  }
} finally {
  await browser.close();
}
