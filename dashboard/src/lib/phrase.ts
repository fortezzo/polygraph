// Finds the judge's made-up phrase inside an answer. The engine guarantees the
// phrase is words the bot actually wrote, so an exact match is normal. The
// fallback forgives spacing, quote marks and capitals, like the engine does.

export interface Span {
  start: number;
  end: number;
}

const QUOTES: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "–": "-", "—": "-", " ": " ",
};

/** Lowercased text with straight quotes and single spaces, plus where each character came from. */
function normalize(text: string): { norm: string; from: number[] } {
  let norm = "";
  const from: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < text.length; i++) {
    let c = text[i]!;
    c = QUOTES[c] ?? c;
    if (/\s/.test(c)) {
      if (lastSpace) continue;
      c = " ";
      lastSpace = true;
    } else {
      lastSpace = false;
    }
    norm += c.toLowerCase();
    from.push(i);
  }
  return { norm, from };
}

export function locatePhrase(text: string, phrase: string | null | undefined): Span | null {
  if (!phrase) return null;
  const exact = text.indexOf(phrase);
  if (exact >= 0) return { start: exact, end: exact + phrase.length };
  const t = normalize(text);
  const p = normalize(phrase.trim()).norm;
  if (!p) return null;
  const at = t.norm.indexOf(p);
  if (at < 0) return null;
  const start = t.from[at]!;
  const end = t.from[at + p.length - 1]! + 1;
  return { start, end };
}
