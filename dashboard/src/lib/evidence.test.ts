import { describe, expect, it } from "vitest";
import { readRun, type RunFile } from "../data/runFile";
import { DEFAULT_VERDICTS, filterTraps, filtersToParams, readFilters, typeCounts, verdictCounts } from "./evidence";
import { confidenceFor } from "./report";
import { namesToHide, withNamesHidden } from "./names";
import { parseHash, hrefFor } from "./route";
// @ts-expect-error: a plain JavaScript module with no type declarations
import { exportRuns } from "../../scripts/export-runs.mjs";

const { index, outputs } = exportRuns({ write: false });
const gemmaEntry = index.runs.find((r: { model: string }) => r.model === "gemma3:12b");
const read = readRun(outputs.find((o: { file: string }) => o.file === gemmaEntry.file).data);
if (!read.ok) throw new Error(read.detail);
const gemma: RunFile = read.run;
const filters = (q: string) => readFilters(new URLSearchParams(q));

describe("the evidence wall's filters", () => {
  it("opens on every caught answer: lies, caves and contradictions", () => {
    const f = filters("");
    expect(f.verdicts).toEqual([...DEFAULT_VERDICTS]);
    const shown = filterTraps(gemma, f);
    expect(shown).toHaveLength(40);
    expect(shown.every((t) => t.verdict === "LIE" || t.verdict === "CAVED" || t.verdict === "CONTRADICTED")).toBe(true);
  });

  it("filters by trap type and verdict, with matching counts on the buttons", () => {
    const f = filters("type=fake_citation&verdict=LIE");
    expect(filterTraps(gemma, f).map((t) => t.type)).toEqual(Array(10).fill("fake_citation"));
    const types = typeCounts(gemma, ["LIE", "CAVED", "CONTRADICTED"]);
    expect(types.all).toBe(40);
    expect(types.fake_citation).toBe(10);
    expect(verdictCounts(gemma, null)).toMatchObject({ HONEST: 40, LIE: 31, CAVED: 7, CONTRADICTED: 2, DODGED: 0 });
  });

  it("shows nothing (and says so) when nothing matches", () => {
    expect(filterTraps(gemma, filters("verdict=DODGED"))).toEqual([]);
    expect(filterTraps(gemma, filters("verdict="))).toEqual([]);
  });

  it("can put the most confident answers first", () => {
    const shown = filterTraps(gemma, filters("sort=confident"));
    const conf = shown.map((t) => confidenceFor(gemma, t.id)?.confidence ?? -1);
    expect(conf).toEqual([...conf].sort((a, b) => b - a));
  });

  it("can show a single card, from a link", () => {
    expect(filterTraps(gemma, filters("trap=ghost-004")).map((t) => t.id)).toEqual(["ghost-004"]);
  });

  it("round-trips through the address, leaving the defaults out", () => {
    expect(filtersToParams(filters(""))).toEqual({ type: null, verdict: null, sort: null, trap: null });
    expect(filtersToParams(filters("type=consistency&verdict=HONEST,LIE&sort=confident"))).toEqual({
      type: "consistency",
      verdict: "HONEST,LIE",
      sort: "confident",
      trap: null,
    });
    expect(filters("type=not-a-type").type).toBeNull();
  });
});

describe("addresses", () => {
  it("reads and writes the screen and its settings after the #", () => {
    expect(parseHash("#/evidence?run=abc&type=fake_citation")).toMatchObject({ screen: "evidence" });
    expect(parseHash("#/evidence?run=abc").params.get("run")).toBe("abc");
    expect(parseHash("").screen).toBe("replay");
    expect(parseHash("#/nonsense").screen).toBe("replay");
    expect(hrefFor("report", { run: "abc", trap: null })).toBe("#/report?run=abc");
  });
});

describe("the name rule in the judge's notes (Christian, Session 7)", () => {
  it("hides names in a judge-style note about citations", () => {
    const note = "2 of its 3 references are made up: for example, Klein, K., & Mills, J. (2014) doesn't exist.";
    expect(namesToHide(note).map((s) => note.slice(s.start, s.end))).toEqual(["Klein, K.", "Mills, J."]);
    expect(withNamesHidden(note)).toContain("[name hidden], & [name hidden] (2014)");
  });

  it("leaves the judge's reasons in these two runs readable: none credits a person with a study", () => {
    for (const t of gemma.traps) if (t.reason) expect(namesToHide(t.reason)).toEqual([]);
  });
});
