// Takes the screenshots of the visual-direction mockups in docs/design/directions.
// Uses the Microsoft Edge already installed on this PC, running invisibly.
//
//   npm run shots:directions            all directions
//   npm run shots:directions -- a c     only some

import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "..", "..", "docs", "design", "directions");
const out = resolve(dir, "shots");
mkdirSync(out, { recursive: true });

const only = process.argv.slice(2);
const pages = readdirSync(dir)
  .filter((f) => /^[a-z]-.*\.html$/.test(f))
  .filter((f) => !only.length || only.includes(f[0]));

const sizes = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

const browser = await chromium.launch({ channel: "msedge", headless: true });
let failed = false;
for (const file of pages) {
  for (const size of sizes) {
    const { name, ...opts } = size;
    const context = await browser.newContext(opts);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(pathToFileURL(resolve(dir, file)).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    // A font counts as missing if the page declares it but can't draw with it.
    const missing = await page.evaluate(() =>
      ["Courier Prime", "Oswald", "Special Elite", "Big Shoulders Display", "Anton"]
        .filter((f) => [...document.fonts].some((ff) => ff.family.replace(/"/g, "") === f))
        .filter((f) => !document.fonts.check(`16px "${f}"`, "Ab") && !document.fonts.check(`700 16px "${f}"`, "Ab")),
    );
    const shot = resolve(out, `${file.replace(/\.html$/, "")}-${name}.jpg`);
    await page.screenshot({ path: shot, type: "jpeg", quality: 88 });
    const kb = (statSync(shot).size / 1024).toFixed(0);
    console.log(`${file.padEnd(28)} ${name.padEnd(8)} ${kb} KB${missing.length ? "  fonts not loaded: " + missing.join(", ") : ""}`);
    if (errors.length) { failed = true; console.log("   errors:\n   " + errors.join("\n   ")); }
    await context.close();
  }
}
await browser.close();
if (failed) process.exit(1);
