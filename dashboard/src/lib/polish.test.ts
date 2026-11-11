// Session 11: the polish pass. Friendly model names, and the smaller copies of each
// run that let the report card, the overconfidence meter and the evidence wall open
// sooner on a phone.

import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain JavaScript module
import { exportRuns, readRoster } from "../../scripts/export-runs.mjs";
import { readRun, type RunFile, type TrapResult } from "../data/runFile";
import { modelName, hasOwnName, NAMED_TAGS } from "./models";
import { CAUGHT, mostConfidentCheckedLie } from "./report";
import { filterTraps, readFilters, typeCounts, verdictCounts } from "./evidence";
import { entryDisplay, recordingDisplay, subjectOf, type RunEntry } from "./runs";

const { index, outputs } = exportRuns({ write: false, committedOnly: true });
const roster = readRoster();

describe("friendly model names (Christian, Session 11)", () => {
  it("gives every bot in the lineup and every judge the name its maker uses", () => {
    expect(modelName("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(modelName("gpt-6.1-terra")).toBe("GPT-6.1 Terra");
    expect(modelName("gpt-6-astra")).toBe("GPT-6 Astra");
    expect(modelName("claude-haiku-5-5")).toBe("Claude Haiku 5.5");
    expect(modelName("gemma3:12b")).toBe("Gemma 3 12B");
    expect(modelName("gemma4:12b")).toBe("Gemma 4 12B");
    expect(modelName("ministral-3:14b")).toBe("Ministral 3 14B");
    expect(modelName("phi4:14b")).toBe("Phi-4 14B");
    expect(modelName("llama3.2")).toBe("Llama 3.2 3B");
    expect(modelName("qwen3.6:35b")).toBe("Qwen3.6 35B");
    for (const b of roster.bots) expect(hasOwnName(b.model), b.model).toBe(true);
    expect(hasOwnName(roster.judge)).toBe(true);
    expect(hasOwnName(roster.second_opinion.judge)).toBe(true);
  });

  it("shows any other tag as it is", () => {
    expect(modelName("some-new-model:7b")).toBe("some-new-model:7b");
    expect(hasOwnName("some-new-model:7b")).toBe(false);
    expect(modelName(null)).toBe("");
  });

  it("names every judged run with a friendly name, and puts the exact tag in the small print", () => {
    for (const e of index.runs as RunEntry[]) {
      const shown = entryDisplay(e);
      if (hasOwnName(e.model)) expect(shown.main).toContain(modelName(e.model));
      expect(shown.sub.startsWith(e.model)).toBe(true);
      expect(subjectOf(e)).not.toContain(e.model === modelName(e.model) ? "\u0000" : e.model);
    }
  });

  it("never names a model twice in a whole recording's picker line", () => {
    for (const r of index.runs.filter((e: RunEntry) => e.role === "lineup")) {
      const shown = recordingDisplay(r);
      expect(shown.main.split(modelName(r.model)).length - 1).toBe(1);
      expect(shown.sub).toContain(`all ${r.traps} questions`);
    }
  });

  it("only lists tags it has names for", () => {
    expect(NAMED_TAGS.length).toBeGreaterThan(8);
  });
});

const read = (data: unknown): RunFile => {
  const r = readRun(data);
  if (!r.ok) throw new Error(r.detail);
  return r.run;
};

describe("the light copy of a run (report card and overconfidence meter)", () => {
  it("is a small part of the whole run", () => {
    for (const o of outputs) expect(JSON.stringify(o.light.data).length).toBeLessThan(JSON.stringify(o.data).length * 0.2);
  });

  it("has the same run details and scores as the whole run", () => {
    for (const o of outputs) {
      const light = read(o.light.data);
      const full = read(o.data);
      expect(light.run).toEqual(full.run);
      expect(light.scores).toEqual(full.scores);
      expect(light.traps.length).toBe(full.traps.length);
      for (const [i, t] of light.traps.entries()) {
        expect(t.id).toBe(full.traps[i]!.id);
        expect(t.verdict ?? null).toBe(full.traps[i]!.verdict ?? null);
        expect(t.hand_label ?? null).toEqual(full.traps[i]!.hand_label ?? null);
      }
    }
  });

  it("keeps whole the one card the overconfidence meter shows, the same one it picks from the whole run", () => {
    for (const o of outputs) {
      const full = read(o.data);
      const light = read(o.light.data);
      const fromFull = mostConfidentCheckedLie(full);
      const fromLight = mostConfidentCheckedLie(light);
      expect(fromLight?.trap.id ?? null).toBe(fromFull?.trap.id ?? null);
      if (fromFull) expect(fromLight!.trap).toEqual(fromFull.trap);
    }
  });
});

describe("the caught copy of a run (the evidence wall)", () => {
  it("has every caught answer word for word, and the rest only by their verdicts", () => {
    for (const o of outputs) {
      const full = read(o.data);
      const caught = read(o.caught.data);
      const byId = new Map(full.traps.map((t: TrapResult) => [t.id, t]));
      for (const t of caught.traps) {
        const whole = byId.get(t.id)!;
        if (t.verdict && CAUGHT.includes(t.verdict)) {
          expect(t.conversations.map((c) => c.turns.map((x) => x.content))).toEqual(whole.conversations.map((c) => c.turns.map((x) => x.content)));
          expect(t.made_up_phrase).toBe(whole.made_up_phrase);
          expect(t.reason).toBe(whole.reason);
          expect(t.trap.truth).toBe(whole.trap.truth);
          expect(t.trap.source).toEqual(whole.trap.source);
          expect(t.judgement?.hard_check ?? null).toEqual(whole.judgement?.hard_check ?? null);
        } else {
          expect(t.conversations).toEqual([]);
        }
      }
    }
  });

  it("shows the wall's default view and its counts exactly as the whole run does", () => {
    const f = readFilters(new URLSearchParams());
    for (const o of outputs) {
      const full = read(o.data);
      const caught = read(o.caught.data);
      expect(filterTraps(caught, f).map((t) => t.id)).toEqual(filterTraps(full, f).map((t) => t.id));
      expect(typeCounts(caught, f.verdicts)).toEqual(typeCounts(full, f.verdicts));
      expect(verdictCounts(caught, null)).toEqual(verdictCounts(full, null));
    }
  });

  it("is listed in the run index, with the light copy", () => {
    for (const e of index.runs) {
      expect(e.light_file).toBe(`${e.id}.light.json`);
      expect(e.caught_file).toBe(`${e.id}.caught.json`);
    }
  });
});
