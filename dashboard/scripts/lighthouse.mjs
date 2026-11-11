// Session 11: Google Lighthouse on the demo, at phone and laptop settings.
//
// Lighthouse is installed for this project only, in ..\.tools\lighthouse (git
// ignores it). To install it again on a fresh copy, in the .tools\lighthouse
// folder: npm install lighthouse@13.6.0 --before=2026-10-28T00:00:00Z
// It uses the Google Chrome already on this PC.
//
//   node scripts/lighthouse.mjs                        the built demo (npm run build:demo), served on this PC
//   node scripts/lighthouse.mjs --url https://fortezzo.github.io/polygraph/
//   node scripts/lighthouse.mjs --runs 1 --only replay --out <folder>
//   node scripts/lighthouse.mjs --cert <folder with cert.pem and key.pem>
//
// With --cert, the local copy is served over HTTP/2 and HTTPS, as GitHub Pages
// serves it (Lighthouse charges plain HTTP/1.1 for extra connections, so without
// it the local numbers come out a few points lower than the live site's). A
// self-signed certificate is fine: Chrome is told to accept it.
//
// The local copy is served the way GitHub Pages serves the demo: compressed
// (gzip), from a /polygraph/ folder, with GitHub's 10-minute cache. Each page is
// measured --runs times (3 by default) at each setting, and the run with the
// middle Performance score is kept, because Lighthouse varies from run to run.

import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = resolve(here, "..");
const tools = resolve(dashboard, "..", ".tools", "lighthouse", "node_modules");
if (!existsSync(resolve(tools, "lighthouse"))) {
  console.error("Lighthouse isn't installed. See the top of scripts/lighthouse.mjs.");
  process.exit(1);
}
const { default: lighthouse, desktopConfig } = await import(pathToFileURL(resolve(tools, "lighthouse", "core", "index.js")).href);
const chromeLauncher = await import(pathToFileURL(resolve(tools, "chrome-launcher", "dist", "index.js")).href);

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const remote = opt("--url", null);
const runs = Number(opt("--runs", 3));
const only = opt("--only", null);
const onlyForm = opt("--form", null);
// The summary (small, kept in git) and the full reports (about 1 MB each, kept out of git).
const out = resolve(opt("--out", resolve(dashboard, "..", "docs", "screenshots", "session-11")));
const name = opt("--name", "lighthouse");
const reports = resolve(opt("--reports", resolve(process.env.TEMP ?? dashboard, "polygraph-lighthouse")));
const root = resolve(opt("--dist", resolve(dashboard, "dist")));
mkdirSync(out, { recursive: true });
mkdirSync(reports, { recursive: true });

export const PAGES = [
  { name: "replay", hash: "", what: "the first page: the Highlights replay" },
  { name: "report", hash: "#/report", what: "the report card" },
  { name: "evidence", hash: "#/evidence", what: "the evidence wall" },
  { name: "confidence", hash: "#/confidence", what: "the overconfidence meter" },
  { name: "lineup", hash: "#/lineup", what: "the lineup" },
];
const FORMS = ["mobile", "desktop"];
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

// ---- A copy of GitHub Pages on this PC ----------------------------------------
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".jpg": "image/jpeg", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
};
const COMPRESS = new Set([".html", ".js", ".css", ".json", ".svg", ".ico", ".webmanifest", ".txt"]);
function pagesServer(cert) {
  const handler = (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/polygraph/")) {
      res.writeHead(url.pathname === "/" ? 302 : 404, url.pathname === "/" ? { Location: "/polygraph/" } : {});
      return res.end();
    }
    let rel = decodeURIComponent(url.pathname.slice("/polygraph/".length)) || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = resolve(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }
    const ext = extname(file);
    let body = readFileSync(file);
    const headers = { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": "max-age=600", Vary: "Accept-Encoding" };
    if (COMPRESS.has(ext) && /gzip/.test(req.headers["accept-encoding"] ?? "")) {
      body = gzipSync(body, { level: 6 });
      headers["Content-Encoding"] = "gzip";
    }
    headers["Content-Length"] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  };
  if (cert) {
    return createSecureServer({ key: readFileSync(resolve(cert, "key.pem")), cert: readFileSync(resolve(cert, "cert.pem")), allowHTTP1: true }, handler);
  }
  return createServer(handler);
}

let server = null;
let base = remote;
if (!base) {
  if (!existsSync(resolve(root, "index.html"))) {
    console.error(`No built demo in ${root}. Run npm run build:demo first.`);
    process.exit(1);
  }
  const cert = opt("--cert", null);
  server = pagesServer(cert);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `${cert ? "https" : "http"}://127.0.0.1:${server.address().port}/polygraph/`;
}
if (!base.endsWith("/")) base += "/";

// ---- Measure ------------------------------------------------------------------
const pct = (x) => (x === null || x === undefined ? null : Math.round(x * 100));
const ms = (a) => (a?.numericValue === undefined ? null : Math.round(a.numericValue));

function summarize(lhr) {
  const a = lhr.audits;
  const failing = [];
  for (const cat of CATEGORIES) {
    for (const ref of lhr.categories[cat].auditRefs) {
      const audit = a[ref.id];
      if (!audit || audit.score === null || ["notApplicable", "informative", "manual"].includes(audit.scoreDisplayMode)) continue;
      if (audit.score < 0.9) failing.push({ category: cat, id: ref.id, weight: ref.weight, score: pct(audit.score), title: audit.title, value: audit.displayValue ?? null });
    }
  }
  const lcpEl = a["largest-contentful-paint-element"]?.details?.items?.[0]?.items?.[0]?.node;
  return {
    scores: Object.fromEntries(CATEGORIES.map((c) => [c, pct(lhr.categories[c].score)])),
    metrics: {
      fcp_ms: ms(a["first-contentful-paint"]),
      lcp_ms: ms(a["largest-contentful-paint"]),
      tbt_ms: ms(a["total-blocking-time"]),
      cls: a["cumulative-layout-shift"]?.numericValue === undefined ? null : +a["cumulative-layout-shift"].numericValue.toFixed(4),
      speed_index_ms: ms(a["speed-index"]),
      total_kb: a["total-byte-weight"]?.numericValue === undefined ? null : Math.round(a["total-byte-weight"].numericValue / 1024),
    },
    lcp_element: lcpEl ? `${lcpEl.nodeLabel ?? ""} (${lcpEl.selector ?? ""})`.trim() : null,
    failing,
  };
}

const chrome = await chromeLauncher.launch({
  chromeFlags: ["--headless=new", "--no-first-run", "--no-default-browser-check", ...(opt("--cert", null) ? ["--ignore-certificate-errors"] : [])],
});
const results = { base: remote ?? `a local copy of the demo build, served like GitHub Pages${opt("--cert", null) ? " (compressed, over HTTP/2)" : " (compressed, over HTTP/1.1, so a few points low)"}`, lighthouse: null, measured_at: new Date().toISOString(), runs, pages: {} };
try {
  for (const page of PAGES) {
    if (only && !only.split(",").includes(page.name)) continue;
    for (const form of FORMS) {
      if (onlyForm && form !== onlyForm) continue;
      const tries = [];
      for (let i = 0; i < runs; i++) {
        const r = await lighthouse(base + page.hash, { port: chrome.port, output: "html", logLevel: "error", onlyCategories: CATEGORIES }, form === "desktop" ? desktopConfig : undefined);
        if (!r?.lhr) throw new Error(`Lighthouse gave no result for ${page.name} (${form})`);
        if (r.lhr.runtimeError) throw new Error(`Lighthouse couldn't load ${page.name} (${form}): ${r.lhr.runtimeError.message}`);
        results.lighthouse = r.lhr.lighthouseVersion;
        tries.push({ lhr: r.lhr, html: r.report });
      }
      tries.sort((x, y) => (x.lhr.categories.performance.score ?? 0) - (y.lhr.categories.performance.score ?? 0));
      const mid = tries[Math.floor(tries.length / 2)];
      const s = summarize(mid.lhr);
      s.performance_runs = tries.map((t) => pct(t.lhr.categories.performance.score));
      results.pages[`${page.name} ${form}`] = { page: page.what, url: base + page.hash, form, ...s };
      writeFileSync(resolve(reports, `${name}-${page.name}-${form}.html`), mid.html);
      const sc = s.scores;
      console.log(
        `${page.name.padEnd(10)} ${form.padEnd(7)} perf ${String(sc.performance).padStart(3)} (runs ${s.performance_runs.join("/")})  a11y ${sc.accessibility}  best ${sc["best-practices"]}  seo ${sc.seo}  ` +
          `| FCP ${s.metrics.fcp_ms} LCP ${s.metrics.lcp_ms} TBT ${s.metrics.tbt_ms} CLS ${s.metrics.cls} SI ${s.metrics.speed_index_ms} ms, ${s.metrics.total_kb} KB`,
      );
      for (const f of s.failing) console.log(`      ${f.category}: ${f.title}${f.value ? ` (${f.value})` : ""} [${f.score}]`);
    }
  }
  writeFileSync(resolve(out, `${name}.json`), JSON.stringify(results, null, 2) + "\n");
  console.log(`saved ${resolve(out, `${name}.json`)}, with the full reports in ${reports}`);
} finally {
  await chrome.kill();
  if (server) await new Promise((r) => server.close(r));
}
