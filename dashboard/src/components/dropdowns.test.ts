// Session 12 (Christian, before the LinkedIn post): on Windows, Chrome and Edge draw
// an open <select> list as a small white page of their own, with the select's
// background under the options and each option in its own computed colors. The
// bot picker's options inherited its see-through text, so the open list was blank
// white, apart from the browser's highlight on the option under the mouse.
//
// Playwright can't photograph a native list, so this opens every screen that has a
// dropdown in a real Edge (or Chrome) and reads the colors the browser draws the
// open list from. Every option and group heading needs solid text, on a solid
// background (its own, its group's or its select's), at least 4.5 to 1 (WCAG AA).
// The closed pickers have to stay invisible over their two-line labels.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright-core";
// @ts-expect-error: a plain JavaScript module
import { exportRuns } from "../../scripts/export-runs.mjs";
import type { Setup } from "../lib/api";

const DASHBOARD = fileURLToPath(new URL("../..", import.meta.url));

// ---- Colors -------------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A computed color, like "rgb(239, 230, 213)" or "rgba(0, 0, 0, 0)". */
function rgba(css: string): Rgba {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(css);
  if (!m) throw new Error(`can't read the color "${css}"`);
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
}

const luminance = ({ r, g, b }: Rgba) => {
  const [x, y, z] = [r, g, b].map((c) => c / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * x! + 0.7152 * y! + 0.0722 * z!;
};

const contrast = (p: Rgba, q: Rgba) => {
  const [hi, lo] = [luminance(p), luminance(q)].sort((s, t) => t - s);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("reading colors", () => {
  it("reads the browser's computed colors, and works out contrast as WCAG does", () => {
    expect(rgba("rgb(239, 230, 213)")).toEqual({ r: 239, g: 230, b: 213, a: 1 });
    expect(rgba("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(rgba("rgb(23 19 15 / 50%)").a).toBe(0.5);
    expect(() => rgba("oklab(1 0 0)")).toThrow();
    expect(contrast(rgba("rgb(0, 0, 0)"), rgba("rgb(255, 255, 255)"))).toBeCloseTo(21, 5);
  });
});

// ---- What the open lists are drawn from ------------------------------------------------

interface Item {
  kind: string;
  text: string;
  disabled: boolean;
  color: string;
  background: string;
  group: { color: string; background: string } | null;
}

interface Dropdown {
  name: string;
  color: string;
  background: string;
  opacity: string;
  items: Item[];
}

/** Every select on the page: its own colors, and its options' and group headings'. */
const readDropdowns = (page: Page): Promise<Dropdown[]> =>
  page.$$eval("select", (selects) =>
    selects.map((el) => {
      const select = el as HTMLSelectElement;
      const style = getComputedStyle(select);
      const label = select.labels?.[0];
      return {
        // The picker's words for screen readers ("Recording", "Subject"), or the select's id.
        name: label?.querySelector(".sr-only")?.textContent ?? select.id,
        color: style.color,
        background: style.backgroundColor,
        opacity: style.opacity,
        items: [...select.querySelectorAll("optgroup, option")].map((item) => {
          const own = getComputedStyle(item);
          const parent = item.parentElement;
          const group = parent instanceof HTMLOptGroupElement ? getComputedStyle(parent) : null;
          return {
            kind: item instanceof HTMLOptGroupElement ? "heading" : "option",
            text: item instanceof HTMLOptGroupElement ? item.label : (item.textContent ?? ""),
            disabled: item instanceof HTMLOptionElement && item.disabled,
            color: own.color,
            background: own.backgroundColor,
            group: group && { color: group.color, background: group.backgroundColor },
          };
        }),
      };
    }),
  );

const PICKERS = ["Recording", "Subject"];

/** What would make an open list hard or impossible to read, in words. */
function problems(screen: string, dropdowns: Dropdown[]): string[] {
  const found: string[] = [];
  for (const d of dropdowns) {
    // A picker is a select laid invisibly over its two-line label.
    if (PICKERS.includes(d.name) && (d.opacity !== "0" || rgba(d.color).a !== 0)) {
      found.push(`${screen}, ${d.name}: the closed picker can be seen (opacity ${d.opacity}, text ${d.color})`);
    }
    for (const item of d.items) {
      const where = `${screen}, ${d.name}: the ${item.kind} "${item.text.trim().slice(0, 48)}"`;
      const text = rgba(item.color);
      // The list paints a row on the first background that isn't see-through: the
      // row's own, its group's, then the select's. Under those is the browser's white.
      const under = [item.background, item.group?.background, d.background]
        .filter((c): c is string => !!c)
        .map(rgba)
        .find((c) => c.a > 0);
      if (!under || under.a < 1) {
        found.push(`${where} has no solid background, so the browser's white shows through`);
      } else if (text.a < 1) {
        found.push(`${where} has see-through text (${item.color})`);
      } else if (item.disabled && item.color === (item.group?.color ?? d.color)) {
        // Chrome and Edge only pass an option's color on to the list when it differs from
        // its group's or select's. One that can't be picked and only inherits its color
        // is painted in the browser's light gray (#aaa on this dark page).
        found.push(`${where} can't be picked and has no color of its own, so the list paints it light gray`);
      } else if (contrast(text, under) < 4.5) {
        found.push(`${where} is ${contrast(text, under).toFixed(2)} to 1 against its background, under 4.5 to 1`);
      }
    }
  }
  return found;
}

// ---- The screens ---------------------------------------------------------------------

// What the New interrogation screen gets from Polygraph's server: bots on this PC,
// and a cloud group with a bot that can't be picked (its API key isn't in .env).
const SETUP: Setup = {
  bots: [
    { provider: "ollama", provider_label: "Ollama", model: "test-local-bot", maker: "Maker A", local: true, available: true, why_not: null, size: "8 GB", price_in: 0, price_out: 0 },
    { provider: "openai", provider_label: "OpenAI", model: "test-cloud-bot", maker: "Maker B", local: false, available: true, why_not: null, price_in: 1, price_out: 2 },
    { provider: "openai", provider_label: "OpenAI", model: "test-cloud-bot-2", maker: "Maker B", local: false, available: false, why_not: "No API key in .env", price_in: 1, price_out: 2 },
  ],
  judges: [{ provider: "anthropic", provider_label: "Anthropic", model: "test-judge", maker: "Maker C", local: false, available: true, why_not: null, price_in: 1, price_out: 2, default: true }],
  trap_types: [{ type: "fake_citation", label: "Fake citations", count: 25 }],
  ollama: { ok: true, problem: null },
  keys: {},
  limit_usd: 2,
  max_limit_usd: 5,
  votes: 3,
  run: null,
  pretend: false,
};

// The judged runs, as the dashboard's export makes them (only the committed ones, as on GitHub).
const { index, outputs, replays } = exportRuns({ write: false, committedOnly: true });
const RUN_FILES = new Map<string, unknown>([
  ["index.json", index],
  ["replays.json", replays],
]);
for (const o of outputs as { file: string; data: unknown; light: { file: string; data: unknown }; caught: { file: string; data: unknown } }[]) {
  RUN_FILES.set(o.file, o.data);
  RUN_FILES.set(o.light.file, o.light.data);
  RUN_FILES.set(o.caught.file, o.caught.data);
}

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base: string;

/** Microsoft Edge, as every script here uses, or else Google Chrome. */
async function launch(): Promise<Browser> {
  const failed: string[] = [];
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (e) {
      failed.push(`${channel}: ${String((e as Error).message).split("\n")[0]}`);
    }
  }
  throw new Error(`This test needs Microsoft Edge or Google Chrome.\n${failed.join("\n")}`);
}

beforeAll(async () => {
  // The dashboard itself, from its source, with its own Vite settings. Its own cache
  // folder, so it never disturbs a dashboard that's already running.
  server = await createServer({
    root: DASHBOARD,
    configFile: resolve(DASHBOARD, "vite.config.ts"),
    cacheDir: resolve(DASHBOARD, "node_modules/.vite-dropdowns-test"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null },
    logLevel: "error",
    clearScreen: false,
  });
  await server.listen();
  base = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/`;
  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // The runs come from memory, and Polygraph's server is faked: nothing here needs it running.
  await context.route("**/runs/*.json", (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const data = RUN_FILES.get(name);
    return data ? route.fulfill({ json: data }) : route.fulfill({ status: 404, body: "" });
  });
  await context.route("**/api/**", (route) =>
    new URL(route.request().url()).pathname === "/api/setup"
      ? route.fulfill({ json: SETUP })
      : route.fulfill({ status: 404, json: { problem: { title: "Not in this test", message: "Not in this test.", hint: null, kind: "test" } } }),
  );
  page = await context.newPage();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Opens a screen with a fresh page load, and waits for its dropdowns, with their lists filled in. */
async function open(hash: string, ready: string): Promise<Dropdown[]> {
  await page.goto("about:blank");
  await page.goto(base + hash);
  await page.locator(ready).first().waitFor({ state: "attached", timeout: 60_000 });
  return readDropdowns(page);
}

const picker = (name: string) => `label:has(.sr-only:text-is("${name}")) select`;

describe("every dropdown's open list can be read (Session 12)", () => {
  it("the replay's Recording picker", async () => {
    const found = await open("#/replay", `${picker("Recording")} optgroup option`);
    const recording = found.find((d) => d.name === "Recording");
    expect(recording?.items.some((i) => i.kind === "heading")).toBe(true);
    expect(problems("Replay", found)).toEqual([]);
  }, 120_000);

  it("the Recording picker's line that can't be picked, when the recordings don't load", async () => {
    await page.route("**/runs/replays.json", (route) => route.fulfill({ status: 404, body: "" }));
    try {
      const found = await open("#/replay", `${picker("Recording")} option:disabled`);
      expect(found.find((d) => d.name === "Recording")?.items.some((i) => i.disabled)).toBe(true);
      expect(problems("Replay, recordings not loaded", found)).toEqual([]);
    } finally {
      await page.unroute("**/runs/replays.json");
    }
  }, 120_000);

  it.each([
    ["Report card", "#/report"],
    ["Evidence", "#/evidence"],
    ["Confidence", "#/confidence"],
  ])("the Subject picker on the %s tab", async (screen, hash) => {
    const found = await open(hash, `${picker("Subject")} optgroup option`);
    expect(found.find((d) => d.name === "Subject")?.items.some((i) => i.kind === "heading")).toBe(true);
    expect(problems(screen, found)).toEqual([]);
  }, 120_000);

  it("the bot and judge lists on the New interrogation screen (on Christian's PC only, not in the demo)", async () => {
    const found = await open("#/new", "select#bot option:disabled");
    expect(found.map((d) => d.name).sort()).toEqual(["bot", "judge"]);
    expect(problems("New interrogation", found)).toEqual([]);
  }, 120_000);
});
