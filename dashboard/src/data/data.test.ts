import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sample from "../sample/sample-run.json";
import { readRun, VERDICTS } from "./runFile";
import { VERDICT_INFO } from "./verdicts";
import { locatePhrase } from "../lib/phrase";
// The script that made the sample, so this test can check the sample is still faithful.
// @ts-expect-error: a plain JavaScript module with no type declarations
import { buildSample } from "../../scripts/make-sample.mjs";

describe("the sample", () => {
  it("is exactly what the sample script makes from the real run file", () => {
    expect(buildSample()).toEqual(sample);
  });

  it("only uses answers where Polygraph's verdict matches Christian's hand label", () => {
    for (const c of sample.sample.checked) expect(c.label).toBe(c.verdict);
    expect(sample.sample.checked.map((c) => c.trap)).toEqual(sample.traps.map((t) => t.id));
  });

  it("refuses answers Christian didn't label, or labeled differently", () => {
    expect(() => buildSample({ trapIds: ["number-003"] })).toThrow(/didn't label it/);
    expect(() =>
      buildSample({
        runPath: "runs/2026-11-08_21-51-00_ollama_llama3.2_judged-by_gpt-6-luna~5.json",
        trapIds: ["document-009"],
      }),
    ).toThrow(/Polygraph says LIE, Christian's label says HONEST/);
  });

  it("has every made-up phrase word for word in an answer", () => {
    for (const t of sample.traps) {
      if (!t.made_up_phrase) continue;
      const answers = t.conversations.flatMap((c) => c.turns.filter((x) => x.role === "assistant"));
      expect(answers.some((a) => locatePhrase(a.content, t.made_up_phrase)?.start === a.content.indexOf(t.made_up_phrase))).toBe(true);
    }
  });
});

describe("readRun", () => {
  it("accepts the sample", () => {
    expect(readRun(sample).ok).toBe(true);
  });
  it("explains, in plain English, what's wrong with a bad file", () => {
    const cases: [unknown, RegExp][] = [
      [null, /isn't a Polygraph run file/],
      [{ format: "a-spreadsheet" }, /isn't a Polygraph run file/],
      [{ ...sample, format_version: 99 }, /newer version/],
      [{ ...sample, run: {} }, /which bot was interrogated/],
      [{ ...sample, traps: "nope" }, /no list of questions/],
      [{ ...sample, traps: [{}] }, /Question 1 in the file is damaged/],
    ];
    for (const [data, message] of cases) {
      const r = readRun(data);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toMatch(message);
    }
  });
});

describe("verdicts", () => {
  it("every verdict has a word, an icon and a glyph, never just a color", () => {
    for (const v of VERDICTS) {
      const info = VERDICT_INFO[v];
      expect(info.word).toBe(v);
      expect(info.icon).toBeTruthy();
      expect(["✓", "✗", "↓", "≠", "~"]).toContain(info.glyph);
    }
  });
  it("caught verdicts label the needle; honest and dodged don't spike", () => {
    expect(VERDICTS.filter((v) => VERDICT_INFO[v].caught)).toEqual(["LIE", "CAVED", "CONTRADICTED"]);
    for (const v of VERDICTS) expect(!!VERDICT_INFO[v].needleLabel).toBe(VERDICT_INFO[v].caught);
  });
});

// ---- Color contrast (WCAG 2.1 AA: 4.5 to 1 for text) --------------------------

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");
const color = (name: string): string => {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`no --color-${name} in index.css`);
  return m[1]!;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe("contrast", () => {
  const onRoom = ["text", "soft", "muted", "brass", "honest", "lie", "caved", "contradicted", "dodged"];
  it.each(onRoom)("%s text on the dark room is at least 4.5 to 1", (name) => {
    expect(ratio(color(name), color("room"))).toBeGreaterThanOrEqual(4.5);
  });
  const onManila = ["manila-ink", "manila-label", "honest-ink", "lie-ink", "caved-ink", "contradicted-ink", "dodged-ink"];
  it.each(onManila)("%s on both shades of manila is at least 4.5 to 1", (name) => {
    expect(ratio(color(name), color("manila"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color(name), color("manila-2"))).toBeGreaterThanOrEqual(4.5);
  });
  it("pencil notes on the chart paper are at least 4.5 to 1", () => {
    expect(ratio(color("paper-ink"), color("paper"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(color("manila-ink"), color("paper"))).toBeGreaterThanOrEqual(4.5);
  });
});
