import { describe, expect, it } from "vitest";
import { parseAnswer, parseInline, piecesOf, plainText } from "./markdown";

describe("parseInline", () => {
  it("strips bold and italic markers but keeps each letter's place in the raw text", () => {
    const raw = 'The murderer in *Murder at Pellingham Lock* is **Ruth Elm**.';
    const runs = parseInline(raw, 0);
    expect(runs.map((r) => r.text).join("")).toBe("The murderer in Murder at Pellingham Lock is Ruth Elm.");
    for (const r of runs) expect(raw.slice(r.start, r.start + r.text.length)).toBe(r.text);
    expect(runs.find((r) => r.text === "Murder at Pellingham Lock")?.marks).toEqual(["i"]);
    expect(runs.find((r) => r.text === "Ruth Elm")?.marks).toEqual(["b"]);
  });

  it("handles italics inside bold", () => {
    const runs = parseInline("**bold *both* bold**", 0);
    expect(runs.find((r) => r.text === "both")?.marks).toEqual(["b", "i"]);
  });

  it("leaves lone asterisks and snake_case alone", () => {
    expect(parseInline("2 * 3 * 4", 0).map((r) => r.text).join("")).toBe("2 * 3 * 4");
    expect(parseInline("call flatten_deep_list() now", 0).map((r) => r.text).join("")).toBe("call flatten_deep_list() now");
  });

  it("keeps code spans literal", () => {
    const runs = parseInline("use `**not bold**` here", 0);
    expect(runs.find((r) => r.marks.includes("code"))?.text).toBe("**not bold**");
  });
});

describe("parseAnswer", () => {
  it("splits paragraphs, bullets and headings", () => {
    const raw = "Intro line.\n\n**The Crime & Initial Suspects:**\n\n*   **Mr. Penrith:** a partner.\n    *   Nested item.\n1. First\n## Heading";
    const blocks = parseAnswer(raw);
    expect(blocks.map((b) => b.kind)).toEqual(["p", "p", "li", "li", "li", "h"]);
    const nested = blocks[3];
    expect(nested?.kind === "li" && nested.level).toBeGreaterThan(0);
    const numbered = blocks[4];
    expect(numbered?.kind === "li" && numbered.bullet).toBe("1.");
  });

  it("maps every visible letter back to the raw text, line by line", () => {
    const raw = "A *b* c\nsecond line\n\n* item **x**";
    for (const b of parseAnswer(raw)) for (const line of b.lines) for (const r of line) {
      expect(raw.slice(r.start, r.start + r.text.length)).toBe(r.text);
    }
  });

  it("treats a fenced code block as plain text", () => {
    const blocks = parseAnswer("Look:\n```\nx = **1**\n```\nDone.");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "pre", "p"]);
    expect(plainText(blocks)).toContain("x = **1**");
  });
});

describe("piecesOf", () => {
  const raw = "Say **Ruth Elm** did it.";
  const line = parseAnswer(raw)[0]!.lines[0]!;

  it("splits at the reveal point, and unshown text stays in place", () => {
    const pieces = piecesOf(line, raw.indexOf("Elm"), null);
    expect(pieces.filter((p) => p.shown).map((p) => p.text).join("")).toBe("Say Ruth ");
    expect(pieces.map((p) => p.text).join("")).toBe("Say Ruth Elm did it.");
  });

  it("marks exactly the made-up phrase, even across bold markers", () => {
    const start = raw.indexOf("**Ruth");
    const end = raw.indexOf(" did");
    const pieces = piecesOf(line, raw.length, { start, end });
    expect(pieces.filter((p) => p.hot).map((p) => p.text).join("")).toBe("Ruth Elm");
  });
});
