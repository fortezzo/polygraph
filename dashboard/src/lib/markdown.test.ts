import { describe, expect, it } from "vitest";
import { closeOpenMarkers, lastVisibleIn, parseAnswer, parseInline, piecesOf, plainText } from "./markdown";

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

  it("shows a Markdown link as its text, and keeps its place in the raw text", () => {
    const raw = "More here: [https://doi.org/10.1/x](https://doi.org/10.1/x) and **[a paper](https://a.example)**.";
    const runs = parseInline(raw, 0);
    expect(runs.map((r) => r.text).join("")).toBe("More here: https://doi.org/10.1/x and a paper.");
    expect(runs.find((r) => r.text === "a paper")?.marks).toEqual(["b", "link"]);
    for (const r of runs) expect(raw.slice(r.start, r.start + r.text.length)).toBe(r.text);
  });

  it("finds the made-up phrase's last visible letter, even when the quote ends inside a link's address", () => {
    const raw = "**DOI:** [https://doi.org/10.1/x](https://doi.org/10.1/x) is it.";
    const blocks = parseAnswer(raw);
    // The judge quoted up to part-way through the hidden address.
    const quote = { start: 0, end: raw.indexOf("](") + 6 };
    const last = lastVisibleIn(blocks, quote)!;
    expect(raw[last]).toBe("x"); // the end of the link's visible text
    expect(lastVisibleIn(blocks, null)).toBeNull();
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

// Session 11: a live answer still arriving shows its Markdown in its final form.
describe("closing open markers while a live answer streams in", () => {
  const visible = (text: string) => plainText(parseAnswer(text));
  const final = "Some text.\n\n**If you're not using `iteration_utilities` and have a custom `flatten_deep()` function, the behavior may vary.**\n";

  it("never shows a marker that's waiting for its closing half", () => {
    for (let n = 1; n <= final.length; n++) {
      const partial = final.slice(0, n);
      expect(visible(closeOpenMarkers(partial)), JSON.stringify(partial)).not.toMatch(/\*\*|`/);
    }
  });

  it("shows each step as the start of what the finished answer shows, so nothing re-wraps", () => {
    const whole = visible(final);
    for (let n = 1; n <= final.length; n++) {
      const shown = visible(closeOpenMarkers(final.slice(0, n))).trimEnd();
      expect(whole.startsWith(shown), JSON.stringify(final.slice(0, n))).toBe(true);
    }
  });

  it("leaves finished text, and an open code block, as they are", () => {
    expect(closeOpenMarkers(final)).toBe(final);
    expect(closeOpenMarkers("Here:\n```\nx = **2")).toBe("Here:\n```\nx = **2");
    expect(closeOpenMarkers("**Bold so far ")).toBe("**Bold so far** ");
  });
});
