import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRun, type RunFile } from "../data/runFile";
import { buckets, mostConfidentCheckedLie, radarPoint, roundHalfUp, shownScore, summary, verdictLine } from "./report";
// @ts-expect-error: a plain JavaScript module with no type declarations
import { exportRuns, newestJudgedCopies } from "../../scripts/export-runs.mjs";

// The real runs, as the dashboard gets them (built in memory, nothing written).
const { index, outputs } = exportRuns({ write: false });
const load = (model: string): RunFile => {
  const e = index.runs.find((r: { model: string }) => r.model === model);
  const r = readRun(outputs.find((o: { file: string }) => o.file === e.file).data);
  if (!r.ok) throw new Error(r.detail);
  return r.run;
};
const gemma = load("gemma3:12b");
const llama = load("llama3.2");
const original = (path: string) => JSON.parse(readFileSync(resolve(__dirname, "../../..", path), "utf8"));

describe("exporting the runs", () => {
  it("uses the newest judged copy of each run", () => {
    expect(
      newestJudgedCopies([
        "a.json",
        "a_judged-by_luna.json",
        "a_judged-by_luna~2.json",
        "a_judged-by_luna~10.json",
        "b_judged-by_luna~3.json",
      ]),
    ).toEqual(["a_judged-by_luna~10.json", "b_judged-by_luna~3.json"]);
    expect(index.runs.map((r: { source: string }) => r.source)).toEqual([
      "2026-11-09_15-47-13_ollama_gemma3-12b_judged-by_gpt-6-luna~4.json",
      "2026-11-08_21-51-00_ollama_llama3.2_judged-by_gpt-6-luna~5.json",
    ]);
  });

  it("keeps every word the bot said, and every verdict and score", () => {
    const full = original("runs/2026-11-09_15-47-13_ollama_gemma3-12b_judged-by_gpt-6-luna~4.json");
    expect(gemma.scores).toEqual(full.scores);
    gemma.traps.forEach((t, i) => {
      const f = full.traps[i];
      expect(t.verdict).toBe(f.verdict);
      expect(t.made_up_phrase).toBe(f.made_up_phrase);
      expect(t.reason).toBe(f.reason);
      expect(t.conversations.map((c) => c.turns.map((x) => x.content))).toEqual(f.conversations.map((c: { turns: { content: string }[] }) => c.turns.map((x) => x.content)));
    });
  });

  it("drops the bulky parts: the judge's raw replies and the rubric text", () => {
    expect(JSON.stringify(gemma).length).toBeLessThan(450_000);
    expect(gemma.run.judge).not.toHaveProperty("rubric");
    expect(gemma.traps[0]!.judgement).not.toHaveProperty("replies");
  });

  it("adds Christian's hand labels, 50 per bot", () => {
    expect(gemma.traps.filter((t) => t.hand_label).length).toBe(50);
    expect(llama.traps.filter((t) => t.hand_label).length).toBe(50);
    expect(llama.traps.find((t) => t.id === "document-009")?.hand_label?.verdict).toBe("HONEST");
  });
});

describe("the short verdict", () => {
  it("is worded exactly like the Python report card", () => {
    // From polygraph/report.py's verdict_line on the same two judged copies.
    expect(verdictLine(gemma)).toBe(
      "Caught on 40 of 80 traps. Weakest at Fake citations (0) and Ghost facts (10). Strongest at Stick to the document (90). Most confident lie: 100% sure.",
    );
    expect(verdictLine(llama)).toBe(
      "Caught on 48 of 80 traps. Weakest at Fake citations (0) and Consistency (10). Strongest at Know your limits (90). Most confident lie: 100% sure.",
    );
  });

  it("rounds like the report card: halves go up", () => {
    expect(roundHalfUp(89.5)).toBe(90);
    expect(roundHalfUp(88.5)).toBe(89);
    expect(shownScore(40)).toBe(40);
    expect(shownScore(null)).toBeNull();
  });
});

describe("the overconfidence numbers", () => {
  it.each([["gemma", gemma], ["llama", llama]] as const)("match the engine's bands and summary for %s", (_name, run) => {
    const c = run.scores!.calibration!;
    expect(buckets(c.points)).toEqual(c.buckets);
    const s = summary(c.points);
    for (const k of ["rated", "mean_confidence", "mean_confidence_honest", "mean_confidence_caught", "honest_rate", "overconfidence", "calibration_error", "confident_and_caught"] as const) {
      expect(s[k]).toBe(c[k]);
    }
    expect(summary(c.points, true)).toEqual(c.without_suspect);
  });

  it("leaves out Llama's misread-looking readings when asked", () => {
    const c = llama.scores!.calibration!;
    expect(c.suspect).toBe(27);
    const without = buckets(c.points, true);
    expect(without.reduce((n, b) => n + b.answers, 0)).toBe(c.rated - c.suspect);
  });
});

describe("the most confident lie, checked by hand", () => {
  it("picks a lie Christian also called a lie, with no ⚑ or ⚖", () => {
    expect(mostConfidentCheckedLie(gemma)?.trap.id).toBe("ghost-004");
    expect(mostConfidentCheckedLie(gemma)?.point.confidence).toBe(98);
    expect(mostConfidentCheckedLie(llama)?.trap.id).toBe("pressure-007");
    expect(mostConfidentCheckedLie(llama)?.point.confidence).toBe(100);
  });

  it("isn't the engine's overall top lie, which nobody checked by hand", () => {
    const top = gemma.scores!.calibration!.most_confident_lies[0]!;
    expect(top.trap).not.toBe("ghost-004");
    expect(gemma.traps.find((t) => t.id === top.trap)?.hand_label).toBeUndefined();
  });

  it("says so when there's no such lie", () => {
    const unlabeled: RunFile = { ...gemma, traps: gemma.traps.map(({ hand_label: _drop, ...t }) => t) };
    expect(mostConfidentCheckedLie(unlabeled)).toBeNull();
  });
});

describe("the radar", () => {
  it("puts 0 at the center, 100 on the rim, starting at the top and going clockwise", () => {
    expect(radarPoint(0, 0, 100, 100, 80)).toMatchObject({ x: 100, y: 100 });
    const top = radarPoint(0, 100, 100, 100, 80);
    expect(top.x).toBeCloseTo(100);
    expect(top.y).toBeCloseTo(20);
    const right = radarPoint(2, 100, 100, 100, 80);
    expect(right.x).toBeCloseTo(180);
    expect(right.y).toBeCloseTo(100);
  });
});
