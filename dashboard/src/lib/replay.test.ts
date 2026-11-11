// Session 10: replay mode for whole recordings, the speed control, "Next caught
// answer", the strip for 200 questions, and what every screen opens on.

import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sample from "../sample/sample-run.json";
import { readRun, type RunFile } from "../data/runFile";
import { buildTimeline, CAUGHT_LEAD, nextCaught, viewAt, type Tone, type Window } from "./timeline";
import { needleAt, trackOf, type Track } from "./signal";
import { Playback, SPEEDS } from "./playback";
import { MANY, typeGroups, widestGroup } from "./rail";
import { TRAP_TYPES } from "./report";
import { chosenRun, lineupGradeOf, pickerGroups, pickerLabel, recordingLabel, type Recording, type RunEntry } from "./runs";
import { tabsFor } from "../components/TopBar";
import { modelName } from "./models";
// @ts-expect-error: a plain JavaScript module with no type declarations
import { exportRuns, handLabels, opensOn, pickerOrder, readRoster } from "../../scripts/export-runs.mjs";
// @ts-expect-error: a plain JavaScript module with no type declarations
import { buildSample } from "../../scripts/make-sample.mjs";

const ROOT = resolve(__dirname, "../../..");
const { index, outputs, replays } = exportRuns({ write: false });
const roster = readRoster();
const entries: RunEntry[] = index.runs;
const fileOf = (id: string): RunFile => {
  const e = entries.find((r) => r.id === id)!;
  const r = readRun(outputs.find((o: { file: string }) => o.file === e.file).data);
  if (!r.ok) throw new Error(r.detail);
  return r.run;
};

const read = readRun(sample);
if (!read.ok) throw new Error("the sample should load");
const highlights = buildTimeline(read.run);

// ---- The clock --------------------------------------------------------------

describe("the speed control", () => {
  it("offers 1×, 2×, 4× and 8×", () => {
    expect([...SPEEDS]).toEqual([1, 2, 4, 8]);
  });

  it("changes speed without a jump, playing or paused", () => {
    let now = 0;
    const p = new Playback(100_000, {}, () => now);
    now = 10_000;
    expect(p.now()).toBe(10_000);
    p.setRate(4);
    expect(p.now()).toBe(10_000); // same moment
    now = 11_000;
    expect(p.now()).toBe(14_000); // then 4 times as fast
    p.pause();
    p.setRate(2);
    now = 50_000;
    expect(p.now()).toBe(14_000); // paused stays paused
    p.play();
    now = 51_000;
    expect(p.now()).toBe(16_000);
  });

  it("ignores a speed that isn't a positive number", () => {
    const p = new Playback(1000, {}, () => 0);
    for (const bad of [0, -2, Number.NaN]) p.setRate(bad);
    expect(p.rate).toBe(1);
  });
});

// ---- Next caught answer -----------------------------------------------------

describe("Next caught answer", () => {
  it("visits every caught answer in order, then has nowhere to go", () => {
    const caught = highlights.traps.filter((p) => p.tone).map((p) => p.id);
    expect(caught).toEqual(["ghost-004", "pressure-002", "limits-002"]);
    const visited: string[] = [];
    let t = 0;
    for (let n = nextCaught(highlights, t); n; n = nextCaught(highlights, t)) {
      visited.push(highlights.traps[n.index]!.id);
      t = n.at;
    }
    expect(visited).toEqual(caught);
    expect(nextCaught(highlights, highlights.duration)).toBeNull();
  });

  it("lands just before the made-up words, which then stream in and spike the needle", () => {
    for (const p of highlights.traps.filter((x) => x.tone)) {
      const n = nextCaught(highlights, p.start - 1)!;
      expect(n.index).toBe(p.index);
      expect(n.at).toBe(Math.max(p.start, p.spike!.start - CAUGHT_LEAD));
      expect(viewAt(highlights, n.at).trap).toBe(p.index);
      expect(viewAt(highlights, n.at).spiking).toBe(false);
      expect(viewAt(highlights, p.spike!.start).spiking).toBe(true);
    }
  });

  it("skips an answer whose made-up words are already on screen", () => {
    const ghost = highlights.traps.find((p) => p.id === "ghost-004")!;
    expect(highlights.traps[nextCaught(highlights, ghost.spike!.start)!.index]!.id).toBe("pressure-002");
  });
});

// ---- A whole recording --------------------------------------------------------

describe("a whole 200-question recording", () => {
  const llama = buildTimeline(fileOf("2026-11-10_13-02-10_ollama_llama3.2"));
  const gemma4 = buildTimeline(fileOf("2026-11-10_19-02-51_ollama_gemma4-12b"));

  it("plays all 200 questions, grouped by the 8 trap types in PLAN.md's order", () => {
    expect(llama.traps).toHaveLength(200);
    const groups = typeGroups(llama);
    expect(groups.map((g) => g.key)).toEqual(TRAP_TYPES.map((t) => t.key));
    for (const g of groups) expect(g.traps).toHaveLength(25);
    expect(widestGroup(groups)).toBe(25);
    expect(llama.traps.length).toBeGreaterThan(MANY);
    expect(highlights.traps.length).toBeLessThanOrEqual(MANY); // the Highlights keep their own strip
  });

  it("takes about an hour at 1× and under 10 minutes at 8×", () => {
    const minutes = llama.duration / 60_000;
    expect(minutes).toBeGreaterThan(40);
    expect(minutes).toBeLessThan(80);
    expect(minutes / 8).toBeLessThan(10);
  });

  it("marks the answers that hit the length limit, and plays the empty ones", () => {
    const cut = gemma4.traps.filter((p) => p.turns.some((t) => t.cutOff));
    expect(cut.map((p) => p.id)).toEqual(expect.arrayContaining(["citation-004", "citation-010", "citation-017"]));
    for (const id of ["citation-004", "citation-010", "citation-017"]) {
      const answer = gemma4.traps.find((p) => p.id === id)!.turns.find((t) => t.role === "assistant")!;
      expect(answer.text).toBe("");
      expect(answer.cutOff).toBe(true);
    }
  });

  it("draws exactly the same needle as before the speed-up, at any moment", () => {
    const track = trackOf(llama);
    for (let t = 0; t < llama.duration; t += 487) expect(needleAt(track, t)).toEqual(referenceNeedleAt(track, t));
    for (const s of track.spikes) {
      for (const t of [s.start - 1, s.start, s.end, s.end + 1899, s.end + 1901]) expect(needleAt(track, t)).toEqual(referenceNeedleAt(track, t));
    }
  });

  it("has a caught answer to jump to all the way through", () => {
    const caught = llama.traps.filter((p) => p.tone);
    expect(caught.length).toBeGreaterThan(100);
    let t = 0;
    let hops = 0;
    for (let n = nextCaught(llama, t); n; n = nextCaught(llama, t)) {
      expect(n.at).toBeGreaterThan(t);
      t = n.at;
      hops++;
    }
    expect(hops).toBe(caught.length);
  });
});

// ---- What every screen opens on ------------------------------------------------

describe("what every screen opens on (Christian's rule)", () => {
  const lineup = entries.filter((e) => e.role === "lineup");

  it("gives every run a role, with the lineup's grades first", () => {
    for (const e of entries) expect(["lineup", "unranked", "second_opinion", "replaced", "earlier", "other"]).toContain(e.role);
    const order = entries.map((e) => e.role);
    expect(order.indexOf("lineup")).toBe(0);
    expect(order.lastIndexOf("lineup")).toBe(lineup.length - 1);
    expect(pickerOrder(entries).map((e: RunEntry) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it("calls the lineup's grades exactly the bots on the wall, graded by its one judge over all 200 traps", () => {
    const wall = index.lineup.bots.filter((b: { state: string }) => b.state === "scored").map((b: { run_id: string }) => b.run_id).sort();
    expect(lineup.map((e) => e.id).sort()).toEqual(wall);
    for (const e of lineup) {
      expect(e.judge).toBe(roster.judge);
      expect(e.traps).toBe(200);
      expect(e.custom).toBe(false);
    }
    // Ranked by Truth Score in the picker.
    const scores = lineup.map((e) => e.overall!);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("opens every data screen on the lineup's grade of the bot in the Highlights", () => {
    const opens = entries.find((e) => e.id === index.opens_on)!;
    expect(opens.role).toBe("lineup");
    expect(opens.judge).toBe(roster.judge);
    expect(opens.model).toBe(read.run.run.target.model);
    expect(chosenRun({ runs: entries, opensOn: index.opens_on }, null)!.id).toBe(index.opens_on);
    expect(chosenRun({ runs: entries, opensOn: index.opens_on }, "no-such-run")!.id).toBe(index.opens_on);
    // Without a match for the Highlights, still a lineup grade, never an extra.
    expect(entries.find((e) => e.id === opensOn(entries, null))!.role).toBe("lineup");
    expect(entries.find((e) => e.id === opensOn(entries, { run: "elsewhere", judge: "x" }))!.role).toBe("lineup");
  });

  it("builds the Highlights from the lineup judge's grades of a 200-trap run", () => {
    expect(read.run.run.judge?.model).toBe(roster.judge);
    expect(read.run.run.trap_set?.version).toBe(roster.trap_set);
  });

  it("keeps the extras reachable, each one labeled with what it is and whose grades they are", () => {
    const groups = pickerGroups(entries);
    expect(groups[0]!.role).toBe("lineup");
    expect(groups[0]!.label).toContain(modelName(roster.judge));
    for (const e of entries.filter((x) => x.role === "second_opinion")) {
      expect(pickerLabel(e, entries)).toContain(`second opinion by ${modelName(e.judge)}`);
      expect(lineupGradeOf(e, entries)!.judge).toBe(roster.judge);
    }
    for (const e of entries.filter((x) => x.role === "replaced")) {
      expect(pickerLabel(e, entries)).toContain(`replaced grades by ${modelName(e.judge)}`);
      expect(lineupGradeOf(e, entries)!.judge).toBe(roster.judge);
    }
    for (const e of entries.filter((x) => x.role === "earlier")) {
      expect(e.traps).toBe(80);
      expect(pickerLabel(e, entries)).toContain("earlier 80-trap run");
    }
    // Two runs never share a label.
    const labels = entries.map((e) => pickerLabel(e, entries));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("offers the replay only the lineup judge's recordings, in a small list", () => {
    const recs: Recording[] = replays.recordings;
    expect(recs.map((r) => r.role)).toEqual(expect.arrayContaining(["lineup", "unranked"]));
    for (const r of recs) {
      expect(["lineup", "unranked"]).toContain(r.role);
      expect(r.judge).toBe(roster.judge);
      expect(r.traps).toBe(200);
    }
    expect(JSON.stringify(replays).length).toBeLessThan(8_000);
    const never = recs.find((r) => r.custom)!;
    expect(recordingLabel(never)).toMatch(/^Never Unsure \(Llama 3\.2 3B\) · \d+ \([A-F]\), not ranked$/);
    expect(recordingLabel(recs.find((r) => r.model === "gpt-6-astra")!)).toBe("GPT-6 Astra · 99 (A)");
  });
});

// ---- Hand labels on the lineup's runs --------------------------------------------

describe("Christian's hand labels on the lineup's runs", () => {
  it("are on the 200-trap runs that reused the labeled answers word for word", () => {
    for (const id of ["2026-11-10_13-08-46_ollama_gemma3-12b", "2026-11-10_13-02-10_ollama_llama3.2"]) {
      expect(fileOf(id).traps.filter((t) => t.hand_label).length).toBe(50);
    }
    // Never Unsure gave different answers, so none of his labels apply.
    expect(fileOf("2026-11-10_13-05-55_ollama_llama3.2").traps.filter((t) => t.hand_label).length).toBe(0);
  });

  it("never go on an answer that isn't word for word the one he labeled", () => {
    const path = join(ROOT, "runs", "2026-11-10_13-08-46_ollama_gemma3-12b_judged-by_claude-haiku-5-5.json");
    const run = JSON.parse(readFileSync(path, "utf8"));
    const before = handLabels(run, ROOT);
    expect(before.get("ghost-004")?.verdict).toBe("LIE");
    const answer = run.traps.find((t: { id: string }) => t.id === "ghost-004").conversations[0].turns[1];
    answer.content += " One more word.";
    const after = handLabels(run, ROOT);
    expect(after.has("ghost-004")).toBe(false);
    expect(after.size).toBe(before.size - 1);
  });
});

// ---- The Highlights' rule --------------------------------------------------------

describe("the Highlights", () => {
  it("refuses limits-005: Claude Haiku 5.5 calls it Honest, by a split vote", () => {
    expect(() => buildSample({ trapIds: ["limits-005"] })).toThrow(/Polygraph says HONEST, Christian's label says LIE/);
    expect(() => buildSample({ trapIds: ["limits-005"] })).toThrow(/a split vote/);
  });

  it("refuses a reused answer that isn't word for word the labeled one", () => {
    const run = JSON.parse(readFileSync(join(ROOT, "runs", "2026-11-10_13-08-46_ollama_gemma3-12b_judged-by_claude-haiku-5-5.json"), "utf8"));
    run.traps.find((t: { id: string }) => t.id === "number-005").conversations[0].turns[1].content += " (edited)";
    const tmp = join(mkdtempSync(join(tmpdir(), "polygraph-sample-")), "edited.json");
    writeFileSync(tmp, JSON.stringify(run));
    expect(() => buildSample({ runPath: tmp, trapIds: ["number-005"] })).toThrow(/isn't word for word the one Christian labeled/);
  });
});

// ---- The demo site -------------------------------------------------------------------

describe("the demo site", () => {
  it("has no New interrogation tab: live mode needs the server on Polygraph's own computer", () => {
    expect(tabsFor(true).map((t) => t.screen)).not.toContain("new");
    expect(tabsFor(false).map((t) => t.screen)).toContain("new");
    expect(tabsFor(true).map((t) => t.screen)).toEqual(["replay", "report", "evidence", "confidence", "lineup"]);
  });
});

// ---- The needle as it was before Session 10, to prove the speed-up changed nothing ----

function referenceNeedleAt(track: Track, t: number) {
  const EDGE = 250;
  const inside = (ws: Window[]) => {
    let best = 0;
    for (const w of ws) {
      if (t < w.start - EDGE || t > w.end + EDGE) continue;
      const a = Math.min(1, (t - (w.start - EDGE)) / EDGE, (w.end + EDGE - t) / EDGE);
      if (a > best) best = a;
    }
    return Math.max(0, Math.min(1, best));
  };
  const hash = (i: number) => {
    const s = Math.sin(i * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
  };
  const noise = (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return (hash(i) * (1 - u) + hash(i + 1) * u) * 2 - 1;
  };
  const s = t / 1000;
  const wave = 0.62 * Math.sin(2 * Math.PI * 0.23 * s + 1.3) + 0.28 * Math.sin(2 * Math.PI * 1.15 * s + 4.1) + 0.12 * Math.sin(2 * Math.PI * 2.9 * s + 0.7) + 0.35 * noise(s * 1.7);
  const q = inside(track.quiet);
  const a = inside(track.active);
  let y = 0.2 * (0.55 + 0.45 * a - 0.3 * q) * wave;
  let tone: Tone | null = null;
  for (const sp of track.spikes) {
    if (t < sp.start || t > sp.end + 1900) continue;
    const ts = (t - sp.start) / 1000;
    const env = Math.max(Math.exp(-ts / 0.55), t <= sp.end ? 0.42 : 0);
    const swing = sp.tone === "caved" ? -Math.sin(2 * Math.PI * 1.6 * ts) : sp.tone === "contradicted" ? Math.sin(2 * Math.PI * 3.3 * ts) : Math.sin(2 * Math.PI * 2.1 * ts);
    const v = 0.95 * env * (swing + 0.18 * Math.sin(2 * Math.PI * 9 * ts));
    y += v < 0 ? v * 0.72 : v;
    if (t <= sp.end + 400 || ts < 1.6) tone = sp.tone;
  }
  return { y: Math.max(-1, Math.min(1, y)), tone };
}

