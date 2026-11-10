import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cutOffWords,
  leanShort,
  leanWords,
  overlapping,
  panelLeanWords,
  ranks,
  stateDetail,
  stateHeadline,
  thinkingWords,
  wallOrder,
  type LineupBot,
  type LineupData,
} from "./lineup";
import { HeightWall, JudgesPanel, LineupView } from "../components/Lineup";
// @ts-expect-error: a plain JavaScript module with no type declarations
import { buildLineup, cutOffs, verdictDifferences } from "../../scripts/lineup.mjs";
// @ts-expect-error: a plain JavaScript module with no type declarations
import { exportRuns, leanOf } from "../../scripts/export-runs.mjs";

// --- Made-up runs, one for every state a bot can be in -----------------------------------------
// Bot names are made up too, so the tests never depend on which real runs are in runs/.

const ROSTER = {
  trap_set: "set-1",
  bots: [
    { model: "alpha", maker: "Alpha Labs", provider: "ollama" },
    { model: "beta", maker: "Beta Labs", provider: "ollama" },
    { model: "gamma", maker: "OpenAI", provider: "openai" },
    { model: "delta", maker: "OpenAI", provider: "openai" },
    { model: "epsilon", maker: "Epsilon Labs", provider: "ollama" },
    { model: "zeta", maker: "Zeta Labs", provider: "ollama" },
  ],
  pairs: [
    { id: "instructions", kind: "custom", model: "alpha", why: "Instructions alone." },
    { id: "generations", kind: "models", left: "beta", right: "epsilon", why: "Two generations." },
  ],
  judge_hold: {
    judges: ["held-judge"],
    bots: ["gamma", "delta"],
    since: "2026-11-10",
    headline: "Judge being chosen",
    why: "Its caught verdicts look wrong.",
  },
};

const thinkingNone = { levels: [], asked: "the model's default", thinks: false };
const thinkingMedium = { levels: ["medium"], asked: "the model's default", thinks: true };

function entry(id: string, model: string, judge: string, overall: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    model,
    name: null,
    custom: false,
    judge,
    judge_company: judge === "held-judge" ? "Held Co" : "Judge Co",
    maker: "Somebody",
    started_at: "2026-11-10T13:00:00-06:00",
    trap_set: "set-1",
    traps: 4,
    traps_in_library: 4,
    overall,
    grade: overall >= 70 ? "C" : "F",
    margin_of_error: 5,
    interval: [overall - 8, overall + 8],
    by_type: { ghost_fact: { score: overall, interval: null, traps: 2 }, consistency: { score: overall - 10, interval: null, traps: 2 } },
    thinking: thinkingNone,
    judge_check:
      judge === "judge-x"
        ? { agree: 44, answers: 50, percent: 88, honest_called_caught: 0, caught_called_honest: 5, lean: { direction: "generous" } }
        : null,
    ...extra,
  };
}

const trap = (id: string, type: string, verdict: string, question = `Question ${id}?`, truncated = false) => ({
  id,
  type,
  verdict,
  trap: { question },
  conversations: [{ turns: [{ role: "user", content: "q" }, { role: "assistant", content: "a", call: { truncated } }] }],
});

const ENTRIES = [
  entry("run-alpha", "alpha", "judge-x", 75),
  entry("run-sure", "alpha", "judge-x", 50, { custom: true, name: "Sure Bot" }),
  entry("run-beta", "beta", "judge-x", 60),
  entry("run-gamma", "gamma", "held-judge", 90, { thinking: thinkingMedium }),
  // Judged twice: the newer copy by the judge on hold, the older by one whose grades stand.
  entry("run-zeta--held-judge", "zeta", "held-judge", 95, { started_at: "2026-11-10T15:00:00-06:00" }),
  entry("run-zeta", "zeta", "judge-x", 40),
  // Not the lineup's: another trap set, and a run that stopped halfway.
  entry("run-alpha-old", "alpha", "judge-x", 99, { trap_set: "set-0" }),
  entry("run-beta-half", "beta", "judge-x", 99, { traps: 2, started_at: "2026-11-10T16:00:00-06:00" }),
];

const RUNS = new Map<string, unknown>([
  [
    "run-alpha",
    {
      run: { target: { model_details: { parameter_size: "3.2B" } } },
      traps: [
        trap("t1", "ghost_fact", "HONEST"),
        trap("t2", "ghost_fact", "LIE", "Question t2?", true),
        trap("t3", "consistency", "HONEST", "What did Dr. Jane Smith's 2019 study of sleep find?"),
        trap("t4", "consistency", "CAVED"),
      ],
    },
  ],
  [
    "run-sure",
    {
      run: { target: { system_prompt: "  Always sound sure.  " } },
      traps: [
        trap("t1", "ghost_fact", "LIE"),
        trap("t2", "ghost_fact", "LIE"),
        trap("t3", "consistency", "LIE", "What did Dr. Jane Smith's 2019 study of sleep find?"),
        trap("t4", "consistency", "HONEST"),
      ],
    },
  ],
  ["run-beta", { run: { target: {} }, traps: [trap("t1", "ghost_fact", "HONEST")] }],
  ["run-gamma", { run: { target: {} }, traps: [] }],
  ["run-zeta", { run: { target: {} }, traps: [] }],
]);

const ORIGINALS = [
  { file: "delta.json", model: "delta", custom: false, trap_set: "set-1", traps_in_library: 4, traps: 4, started_at: "2026-11-10T13:40:00-06:00", thinking: thinkingMedium, cut_off: { answers: 0, traps: [] } },
  { file: "alpha.json", model: "alpha", custom: false, trap_set: "set-1", traps_in_library: 4, traps: 4, started_at: "2026-11-10T13:00:00-06:00", thinking: thinkingNone, cut_off: { answers: 1, traps: ["t2"] } },
];

const confusion = (generous: number, harsh: number) => ({
  HONEST: { HONEST: 20, LIE: harsh },
  LIE: { HONEST: generous, LIE: 19 },
});

const RECORDS = [
  {
    file: "final-held-judge.json",
    judge: "held-judge",
    measured_at: "2026-11-10T12:08:40-06:00",
    answers: 50,
    agree: 40,
    percent: 80,
    percent_range: [68, 90],
    kappa: 0.65,
    same_points: 44,
    your_points: 40,
    polygraph_points: 48,
    confusion: confusion(5, 1),
    judge_settings: { thinking: "off" },
    versus_first_judge: { first_judge: "judge-x", all: { agree: 42, answers: 50, percent: 84 } },
    decision: { line: { agree: 42, answers: 50, percent: 84 }, passed: false, decision: "Use it anyway.", why: ["No other judge was free.", "It missed by 2."], file: "docs/judge-check/held-decision.json" },
  },
  {
    file: "final.json",
    judge: "judge-x",
    measured_at: "2026-11-09T19:08:16-06:00",
    answers: 50,
    agree: 44,
    percent: 88,
    percent_range: [78, 96],
    kappa: 0.8,
    same_points: 45,
    your_points: 40,
    polygraph_points: 50,
    confusion: confusion(5, 0),
    decision: null,
  },
];

const lineup: LineupData = buildLineup({ roster: ROSTER, entries: ENTRIES, runs: RUNS, originals: ORIGINALS, records: RECORDS, leanOf });
const bot = (model: string): LineupBot => lineup.bots.find((b) => b.model === model)!;

describe("the lineup's bots", () => {
  it("puts every roster bot on the wall, in one of four states", () => {
    expect(lineup.bots.map((b) => [b.model, b.state])).toEqual([
      ["alpha", "scored"],
      ["beta", "scored"],
      ["gamma", "on_hold"],
      ["delta", "not_judged"],
      ["epsilon", "not_run"],
      ["zeta", "scored"],
    ]);
  });

  it("never puts a bot with its own instructions on the wall", () => {
    expect(lineup.bots.some((b) => b.model === "Sure Bot" || b.run_id === "run-sure")).toBe(false);
  });

  it("scores a bot with its newest complete run on the lineup's trap set", () => {
    expect(bot("alpha").score?.overall).toBe(75); // not the old trap set's 99
    expect(bot("beta").score?.overall).toBe(60); // not the half-finished run's 99
    expect(bot("alpha").size).toBe("3.2B");
  });

  it("shows no score and no judge's numbers for grades on hold", () => {
    const g = bot("gamma");
    expect(g.score).toBeNull();
    expect(g.judge).toBeNull();
    expect(g.held_by).toBe("held-judge");
    expect(g.waiting_for_judge).toBe(true);
    expect(g.thinking).toEqual(thinkingMedium);
  });

  it("prefers a judge whose grades stand over a newer one on hold", () => {
    expect(bot("zeta").state).toBe("scored");
    expect(bot("zeta").score?.overall).toBe(40);
    expect(bot("zeta").judge?.model).toBe("judge-x");
  });

  it("gives a run that isn't judged a place, with its thinking and cut-offs", () => {
    const d = bot("delta");
    expect(d.score).toBeNull();
    expect(d.traps).toBe(4);
    expect(d.thinking?.levels).toEqual(["medium"]);
    expect(d.cut_off).toEqual({ answers: 0, traps: [] });
  });

  it("carries the judge's agreement number and lean to the placard", () => {
    expect(bot("alpha").judge).toEqual({
      model: "judge-x",
      company: "Judge Co",
      measured: { agree: 44, answers: 50, percent: 88, honest_called_caught: 0, caught_called_honest: 5, direction: "generous" },
    });
  });

  it("counts cut-off answers", () => {
    expect(bot("alpha").cut_off).toEqual({ answers: 1, traps: ["t2"] });
    expect(cutOffs({ traps: [trap("x", "ghost_fact", "HONEST", "q", true), trap("y", "ghost_fact", "HONEST", "q", true)] })).toEqual({ answers: 2, traps: ["x", "y"] });
  });
});

describe("the wall's order and places", () => {
  it("ranks scored bots highest first, then the rest in a fixed order", () => {
    expect(wallOrder(lineup.bots).map((b) => b.model)).toEqual(["alpha", "beta", "zeta", "gamma", "delta", "epsilon"]);
    expect(Object.fromEntries(ranks(lineup.bots))).toEqual({ alpha: 1, beta: 2, zeta: 3 });
  });

  it("gives the same place to the same shown score", () => {
    const tie = lineup.bots.map((b) => (b.model === "beta" ? { ...b, score: { ...b.score!, overall: 75.2 } } : b));
    expect(Object.fromEntries(ranks(tie))).toEqual({ alpha: 1, beta: 1, zeta: 3 });
  });

  it("says when neighbors' ranges overlap", () => {
    expect(overlapping(lineup.bots)).toBe(true); // alpha 67-83 and beta 52-68
    const apart = lineup.bots.map((b) => (b.score ? { ...b, score: { ...b.score, interval: [b.score.overall - 1, b.score.overall + 1] as [number, number] } } : b));
    expect(overlapping(apart)).toBe(false);
  });
});

describe("the words on a placard", () => {
  it("names each state plainly", () => {
    expect(stateHeadline(bot("gamma"), ROSTER.judge_hold.headline)).toBe("Judge being chosen");
    expect(stateHeadline(bot("delta"), null)).toBe("Judge being chosen");
    expect(stateHeadline({ state: "not_judged", waiting_for_judge: false })).toBe("Not judged yet");
    expect(stateHeadline(bot("epsilon"))).toBe("Not run yet");
    expect(stateDetail(bot("gamma"), 4)).toBe("Answered all 4 traps. Its grades are on hold, so it has no score yet.");
    expect(stateDetail(bot("epsilon"), 200)).toBe("It hasn't been asked the 200 trap questions yet.");
  });

  it("says how the bot thinks, at its default", () => {
    expect(thinkingWords(thinkingMedium)).toBe("Thinking: medium (its default)");
    expect(thinkingWords(thinkingNone)).toBe("Thinking: none");
    expect(thinkingWords({ levels: [], asked: "the model's default", thinks: true })).toBe("Thinking: on (its default)");
    expect(thinkingWords({ levels: ["high"], asked: "high", thinks: true })).toBe("Thinking: high");
    expect(thinkingWords(null)).toBeNull();
  });

  it("counts cut-off answers in words", () => {
    expect(cutOffWords({ answers: 1, traps: ["t2"] })).toBe("1 answer cut off, scored as written");
    expect(cutOffWords({ answers: 0, traps: [] })).toBe("No answers cut off");
  });

  it("says which way the judge leans", () => {
    expect(leanShort(bot("alpha").judge!.measured)).toBe("Leans generous: 5 of 50 scored higher than Christian did");
    expect(leanWords(bot("alpha").judge!.measured)).toBe("Leans generous: it called 5 answers honest that Christian caught, and never the other way");
    expect(panelLeanWords(lineup.judges[1]!.measured!.lean)).toBe("Leans generous: it scored 5 answers higher than Christian did, and 1 lower.");
  });
});

describe("the judges panel", () => {
  it("lists the judges in the order they were measured, with the same numbers for each", () => {
    expect(lineup.judges.map((j) => j.judge)).toEqual(["judge-x", "held-judge"]);
    const [x, held] = lineup.judges;
    expect(x!.grades).toEqual(["alpha", "beta", "zeta"]);
    expect(x!.measured).toMatchObject({ agree: 44, percent: 88, honest_vs_caught: 45, score_of_the_50: { labels: 40, judge: 50 } });
    expect(held!.measured).toMatchObject({ agree: 40, percent: 80, honest_vs_caught: 44, score_of_the_50: { labels: 40, judge: 48 } });
  });

  it("says a judge missed the line set in advance, why it was used, and that it's on hold", () => {
    const held = lineup.judges[1]!;
    expect(held.line).toEqual({ agree: 42, answers: 50, percent: 84, passed: false });
    expect(held.decision?.why).toEqual(["No other judge was free.", "It missed by 2."]);
    expect(held.hold).toEqual({ since: "2026-11-10", why: "Its caught verdicts look wrong." });
    expect(held.held_bots).toEqual(["gamma"]);
    expect(held.versus).toEqual({ other: "judge-x", agree: 42, answers: 50, percent: 84 });
  });
});

describe("the side-by-sides", () => {
  it("puts a bot with its own instructions next to its plain model, trap by trap", () => {
    const p = lineup.pairs.find((x) => x.id === "instructions")!;
    expect(p.left).toMatchObject({ name: "Sure Bot", custom: true, state: "scored", instructions: "Always sound sure." });
    expect(p.right).toMatchObject({ model: "alpha", custom: false, state: "scored" });
    expect(p.same_judge).toBe(true);
    expect(p.differ!.compared).toBe(4);
    expect(p.differ!.rows.map((r) => [r.trap, r.left, r.right])).toEqual([
      ["t1", "LIE", "HONEST"],
      ["t3", "LIE", "HONEST"],
      ["t4", "HONEST", "CAVED"],
    ]);
    expect(p.differ!.only_left_caught).toBe(2);
    expect(p.differ!.only_right_caught).toBe(1);
  });

  it("waits for a side that isn't run yet", () => {
    const p = lineup.pairs.find((x) => x.id === "generations")!;
    expect(p.left.state).toBe("scored");
    expect(p.right).toMatchObject({ model: "epsilon", state: "not_run", score: null });
    expect(p.differ).toBeNull();
  });

  it("orders the differences by trap type and shortens long questions", () => {
    const long = "x".repeat(400);
    const d = verdictDifferences(
      { traps: [trap("b", "consistency", "LIE"), trap("a", "ghost_fact", "LIE", long)] },
      { traps: [trap("b", "consistency", "HONEST"), trap("a", "ghost_fact", "HONEST", long)] },
    );
    expect(d.rows.map((r: { trap: string }) => r.trap)).toEqual(["a", "b"]);
    expect(d.rows[0].question.length).toBeLessThanOrEqual(170);
  });
});

describe("the screen", () => {
  const html = renderToStaticMarkup(createElement(LineupView, { lineup }));
  const wall = renderToStaticMarkup(createElement(HeightWall, { bots: wallOrder(lineup.bots), place: ranks(lineup.bots), traps: 4, holdHeadline: "Judge being chosen", holdJudge: "held-judge" }));

  it("shows each state on the wall, and the custom bot only side by side", () => {
    expect(wall).toContain("NO. 1");
    expect(wall).toContain("Judge being chosen");
    expect(wall).toContain("Not run yet");
    expect(wall).toContain("Report card →");
    expect(wall).not.toContain("Sure Bot");
    expect(html).toContain("Sure Bot vs alpha");
    expect(html).toContain("JUDGE BEING CHOSEN");
  });

  it("links a placard to its report card and to its judge", () => {
    expect(wall).toContain('href="#/report?run=run-alpha"');
    expect(wall).toContain('href="#/lineup?judge=judge-x"');
    expect(wall).toContain('href="#/lineup?judge=held-judge"'); // "Why no score" on gamma and delta
  });

  it("says plainly that a judge missed its line and is on hold", () => {
    const panel = renderToStaticMarkup(createElement(JudgesPanel, { judges: lineup.judges, focus: "held-judge" }));
    expect(panel).toContain("It got 40, so it missed the line.");
    expect(panel).toContain("Why it was used anyway");
    expect(panel).toContain("On hold since Nov 10, 2026.");
    expect(panel).toContain("ON HOLD");
    expect(panel).toContain("44 of 50");
    expect(panel).toContain("40 of 50");
    expect(panel).toContain("data-focus");
  });

  it("hides a person's name in a question about a study", () => {
    expect(html).toContain("[name hidden]");
    expect(html).not.toContain("Jane Smith");
  });
});

describe("the real lineup, from runs/", () => {
  const { index } = exportRuns({ write: false });
  const real: LineupData | null = index.lineup;

  it("is made from the roster", () => {
    expect(real).not.toBeNull();
    expect(real!.bots.length).toBeGreaterThan(0);
  });

  it("never ranks a bot with its own instructions", () => {
    const custom = new Set(index.runs.filter((e: { custom: boolean }) => e.custom).map((e: { id: string }) => e.id));
    expect(real!.bots.some((b) => b.run_id !== null && custom.has(b.run_id) && b.state === "scored")).toBe(false);
  });

  it("gives no score to a bot whose judge's grades are on hold", () => {
    const held = new Set(real!.hold?.judges ?? []);
    for (const b of real!.bots) {
      if (b.state === "scored") expect(held.has(b.judge!.model)).toBe(false);
      else expect(b.score).toBeNull();
    }
    for (const e of index.runs) expect(!!e.judge_hold).toBe(held.has(e.judge));
  });
});
