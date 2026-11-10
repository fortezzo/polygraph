import { describe, expect, it } from "vitest";
import sample from "../sample/sample-run.json";
import { readRun } from "../data/runFile";
import { NAME_HIDDEN, namesToHide, withNamesHidden } from "./names";
import { buildTimeline } from "./timeline";
import { parseAnswer, piecesOf } from "./markdown";

const hidden = (text: string) => namesToHide(text).map((s) => text.slice(s.start, s.end));

describe("names in made-up studies and citations", () => {
  it.each([
    ["a study's leader", "In 2021, a team of researchers led by Marie-Claire Kambouchner published a study", ["Marie-Claire Kambouchner"]],
    ["a reference list", "Erickson, K. I., & Kramer, A. F. (2010). Exercise and cognition.", ["Erickson, K. I.", "Kramer, A. F."]],
    ["names with Jr and III", "Karpicke, J. D., & Roediger III, H. L. (2008); Pavlik Jr, P. I., & Anderson, M. J.", ["Karpicke, J. D.", "Roediger III, H. L.", "Pavlik Jr, P. I.", "Anderson, M. J."]],
    ["et al.", '1. Maquet et al. (2005) - "Sleep and memory" and "Blood" by Wang, et al.', ["Maquet", "Wang"]],
    ["in-text citations", "In this study, Fang (2015) uses a natural experiment. Blount and Kuhn (2016) use firms.", ["Fang", "Blount", "Kuhn"]],
    ["a title, then its authors", '"Hallucinations in Language Models: A Survey" by Yarin Nili, Tommaso Lelli and Yonatan Zohar', ["Yarin Nili", "Tommaso Lelli", "Yonatan Zohar"]],
    ["and colleagues", "Erickson and colleagues studied 120 older adults.", ["Erickson"]],
    ["a title before a full name", "According to Dr. Jane Smith, the trial failed.", ["Jane Smith"]],
    ["a job, then a full name", "The neuroscientist Steven Pinker argued that it spoke.", ["Steven Pinker"]],
    ["a court decision", "in a unanimous decision written by Justice Butler, upheld the act", ["Justice Butler"]],
    ["letters with accents", "Büchel, C., Busch, N., & Müller, J. (2019)", ["Büchel, C.", "Busch, N.", "Müller, J."]],
  ])("hides %s", (_what, text, names) => {
    expect(hidden(text)).toEqual(names);
  });

  it.each([
    "Thomas Johann Seebeck (1821): Seebeck is usually credited with discovering it.",
    "Hermann von Helmholtz (1822) worked with Seebeck.",
    "Obviously, Julius Caesar died over 2000 years ago.",
    'his later masterpieces like "Dr. Strangelove" and "2001: A Space Odyssey."',
    "Mr. John Hargreaves, a wealthy businessman, is found drowned in the canal.",
    "The study was published by Oxford University Press in 2019.",
    "**Critical Reaction Upon Release (1957):** mixed at first.",
    "The researchers focused on a specific region of DNA.",
  ])("leaves history, fiction and organizations alone: %s", (text) => {
    expect(hidden(text)).toEqual([]);
  });

  it("puts a visible marker where each name was", () => {
    expect(withNamesHidden("A team led by Marie-Claire Kambouchner published it.")).toBe(`A team led by ${NAME_HIDDEN} published it.`);
  });
});

describe("the rule in the sample", () => {
  const read = readRun(sample);
  if (!read.ok) throw new Error("the sample should load");
  const tl = buildTimeline(read.run);

  it("hides only the researcher of the made-up 2021 study, and only in caught answers", () => {
    const all = tl.traps.flatMap((p) => p.turns.flatMap((t) => t.hidden.map((s) => `${p.id}: ${t.text.slice(s.start, s.end)}`)));
    expect(all).toEqual(["limits-005: Marie-Claire Kambouchner"]);
    for (const p of tl.traps.filter((x) => !x.tone)) for (const t of p.turns) expect(t.hidden).toEqual([]);
  });

  it("keeps the original name in the run file", () => {
    const t = sample.traps.find((x) => x.id === "limits-005")!;
    expect(t.conversations[0]!.turns[1]!.content).toContain("led by Marie-Claire Kambouchner");
  });

  it("marks exactly the name's letters for the screen to replace", () => {
    const turn = tl.traps.find((p) => p.id === "limits-005")!.turns.find((t) => t.role === "assistant")!;
    const pieces = parseAnswer(turn.text).flatMap((b) => b.lines.flatMap((l) => piecesOf(l, turn.text.length, null, turn.hidden)));
    expect(pieces.filter((p) => p.hidden !== null).map((p) => p.text).join("")).toBe("Marie-Claire Kambouchner");
  });
});
