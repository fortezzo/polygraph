// Session 11: the paper slows after a stamp on a phone, so the spike and the
// CAUGHT stamp are still in view when the verdict and the confidence show
// (Christian's note after Session 7).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sample from "../sample/sample-run.json";
import { readRun, type RunFile } from "../data/runFile";
import { buildTimeline, type Timeline } from "./timeline";
import { stampX } from "./stamp";
import { HOLD_AFTER, MAX_HOLD, heldPaper, steadyPaper } from "./paper";

const ROOT = resolve(__dirname, "..", "..", "..");
const load = (data: unknown): RunFile => {
  const r = readRun(data);
  if (!r.ok) throw new Error(r.detail);
  return r.run;
};
const recordings: [string, Timeline][] = [
  ["the Highlights", buildTimeline(load(sample))],
  ["Llama 3.2's whole recording", buildTimeline(load(JSON.parse(readFileSync(join(ROOT, "runs", "2026-11-10_13-02-10_ollama_llama3.2_judged-by_claude-haiku-5-5.json"), "utf8"))))],
  ["Gemma 3's whole recording", buildTimeline(load(JSON.parse(readFileSync(join(ROOT, "runs", "2026-11-10_13-08-46_ollama_gemma3-12b_judged-by_claude-haiku-5-5.json"), "utf8"))))],
];

// The chart's real geometry (PEN and SPEED in ChartPaper.tsx), with the stamp's
// width as the browser measures it on each screen, and a little either side.
const PHONES = [
  { name: "phone", w: 358, penX: Math.round(358 * 0.72), speed: 30, widths: [132, 140, 148] },
  { name: "small phone", w: 328, penX: Math.round(328 * 0.72), speed: 30, widths: [136, 140, 144] },
];

describe("steady paper", () => {
  it("moves at one speed, the way it always did", () => {
    const p = steadyPaper(30);
    expect(p.pos(10_000)).toBeCloseTo(300, 9);
    expect(p.shift(2_000, 3_000)).toBeCloseTo(30, 9);
    expect(p.timeAt(450)).toBeCloseTo(15_000, 6);
  });
});

describe.each(PHONES)("the paper on a $name", (screen) => {
  describe.each(recordings)("in %s", (_name, tl) => {
    const caught = tl.traps.filter((p) => p.stampAt !== null);

    it("keeps every CAUGHT stamp fully on the paper until the confidence has been up a while (14 s at most)", () => {
      for (const width of screen.widths) {
        const paper = heldPaper(tl, { w: screen.w, penX: screen.penX, speed: screen.speed, stampWidth: width });
        const geo = { ...screen, shift: (a: number, b: number) => paper.shift(a, b) };
        for (const p of caught) {
          const until = Math.min(p.finalAt + HOLD_AFTER, p.stampAt! + MAX_HOLD);
          for (let t = p.stampAt!; t <= until; t += 100) {
            const x = stampX(p, width, geo, t);
            expect(x, `${p.id} at ${t - p.stampAt!} ms after the stamp, ${width} px stamp`).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    it("lands each stamp exactly where it used to (it only slows after the stamp lands)", () => {
      const width = 140;
      const paper = heldPaper(tl, { w: screen.w, penX: screen.penX, speed: screen.speed, stampWidth: width });
      for (const p of caught) {
        const before = stampX(p, width, screen, p.stampAt!);
        const now = stampX(p, width, { ...screen, shift: (a, b) => paper.shift(a, b) }, p.stampAt!);
        expect(now).toBeCloseTo(before, 6);
      }
    });

    it("never moves backwards, and is back at full speed before the next question", () => {
      const paper = heldPaper(tl, { w: screen.w, penX: screen.penX, speed: screen.speed, stampWidth: 140 });
      let last = -Infinity;
      for (let t = 0; t < tl.duration; t += 250) {
        const p = paper.pos(t);
        expect(p).toBeGreaterThanOrEqual(last);
        last = p;
      }
      for (const p of tl.traps.slice(1)) {
        // The second the next question starts, the paper moves at its steady speed.
        expect(paper.shift(p.start, p.start + 1000)).toBeCloseTo(screen.speed, 6);
      }
    });

    it("finds the moment for a place on the paper (the trace is drawn with it)", () => {
      const paper = heldPaper(tl, { w: screen.w, penX: screen.penX, speed: screen.speed, stampWidth: 140 });
      for (const p of caught.slice(0, 20)) {
        for (const t of [p.stampAt! + 200, p.finalAt, p.finalAt + HOLD_AFTER + 300]) {
          expect(paper.timeAt(paper.pos(t))).toBeCloseTo(t, 0);
        }
      }
    });
  });
});

describe("the paper on a laptop", () => {
  it("never slows: there's room for the stamp already", () => {
    for (const [, tl] of recordings) {
      const paper = heldPaper(tl, { w: 1376, penX: Math.round(1376 * 0.86), speed: 46, stampWidth: 240 });
      for (let t = 0; t < tl.duration; t += 5000) expect(paper.pos(t)).toBeCloseTo((t / 1000) * 46, 6);
    }
  });
});
