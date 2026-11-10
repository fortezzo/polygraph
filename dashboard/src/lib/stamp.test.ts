import { describe, expect, it } from "vitest";
import sample from "../sample/sample-run.json";
import { readRun } from "../data/runFile";
import { buildTimeline } from "./timeline";
import { HOUSING, stampX, stampXOnSheet } from "./stamp";

const read = readRun(sample);
if (!read.ok) throw new Error("the sample should load");
const tl = buildTimeline(read.run);
const caught = tl.traps.filter((p) => p.stampAt !== null);

// The chart's real geometry (PEN and SPEED in ChartPaper.tsx; the paper is the
// screen width minus the side margins), with stamp widths a little on either
// side of what the browser measures.
const SCREENS = [
  { name: "laptop", w: 1376, penX: Math.round(1376 * 0.86), speed: 46, widths: [200, 240, 270], tick: 75 },
  { name: "tablet", w: 900, penX: Math.round(900 * 0.86), speed: 46, widths: [160, 190], tick: 75 },
  { name: "phone", w: 358, penX: Math.round(358 * 0.72), speed: 30, widths: [120, 136, 150], tick: 65 },
  { name: "small phone", w: 328, penX: Math.round(328 * 0.72), speed: 30, widths: [120, 136], tick: 65 },
];

describe.each(SCREENS)("the CAUGHT stamp on a $name", (screen) => {
  it.each(caught.map((p) => [p.id, p] as const))("lands on its own spike: %s", (_id, p) => {
    const at = p.stampAt!;
    const landX = (tau: number) => screen.penX - ((at - tau) / 1000) * screen.speed;
    for (const width of screen.widths) {
      const x = stampX(p, width, screen, at);
      // On the spike: it overlaps the made-up words' stretch of paper.
      expect(x).toBeLessThan(landX(p.spike!.end));
      expect(x + width).toBeGreaterThan(landX(p.spike!.start));
      // Not over the question before: it starts on this question's own paper.
      expect(x).toBeGreaterThanOrEqual(landX(p.start));
      // And the previous question's "✓ honest" tick is clear of it.
      const prev = tl.traps[p.index - 1];
      if (prev) expect(landX(prev.verdictAt) + screen.tick).toBeLessThan(x);
      // Not under the machine housing.
      expect(x + width).toBeLessThanOrEqual(screen.w - HOUSING);
      // Then it rides with the paper.
      expect(stampX(p, width, screen, at + 5000)).toBeCloseTo(x - 5 * screen.speed, 6);
    }
  });
});

describe("the CAUGHT stamp on still paper (reduce motion)", () => {
  it("sits on its spike, inside the sheet", () => {
    for (const p of caught) {
      const w = 1376;
      const left = 16;
      const penX = Math.round(w * 0.86);
      const xOf = (tau: number) => left + ((tau - p.start) / (p.end - p.start)) * (penX - left);
      const width = 240;
      const x = stampXOnSheet(p, width, { w, left, xOf });
      expect(x).toBeGreaterThanOrEqual(left);
      expect(x + width).toBeLessThanOrEqual(w - HOUSING);
      expect(x).toBeLessThan(xOf(p.spike!.end));
      expect(x + width).toBeGreaterThan(xOf(p.spike!.start));
    }
  });
});
