// Christian's rule (Session 6): on screen, people's names inside studies and
// citations that a bot made up are hidden behind a visible "[name hidden]".
// A bot that invents a study often pins it on a real-sounding person, and the
// dashboard shouldn't repeat that. The run files keep the original words.
//
// Where it applies: every answer Polygraph caught (Lie, Caved, Contradicted).
// The interrogation screen uses it, and the evidence wall (Session 7) should too.
//
// A name counts when it comes in one of the shapes citations and studies use:
//   led by Marie-Claire Kambouchner · authored by / conducted by / published by …
//   Erickson, K. I., & Kramer, A. F. (2010)   reference lists
//   Maquet et al. (2005) · Wang, et al.        et al.
//   Fang (2015) · Blount and Kuhn (2016)       in-text citations
//   "Some Title" by Yarin Nili, Ofir Press     a title, then its authors
//   Dr. Jane Smith · Professor Mary Beard      titles, before a full name
//   Erickson and colleagues                    and colleagues
//   researcher Jane Smith                      a job, then a full name
// History stays readable: "Thomas Johann Seebeck (1821)" or "Julius Caesar" on
// their own aren't credited with a study, so they're shown as written.

export const NAME_HIDDEN = "[name hidden]";

export interface Span {
  start: number;
  end: number;
}

const S = "[^\\S\\n]"; // a space that isn't a line break: a name never crosses lines
const WORD = "\\p{Lu}[\\p{L}'’-]*\\p{Ll}"; // Kambouchner, O'Connor, McCann, Marie-Claire, Büchel
const PARTICLE = `(?:(?:van|von|der|den|de|da|di|del|della|du|la|le|bin|ibn)${S})`;
const SUFFIX = `(?:${S}(?:Jr|Sr|II|III|IV)\\.?)?`;
const INITIALS = `\\p{Lu}\\.(?:${S}?\\p{Lu}\\.){0,2}`;
const SURNAME = `${PARTICLE}*${WORD}${SUFFIX}`;
const APA = `${SURNAME},${S}?${INITIALS}`; // Erickson, K. I.
const INITIALS_FIRST = `${INITIALS}${S}?${SURNAME}`; // K. I. Erickson
const FULL = `${WORD}(?:${S}(?:\\p{Lu}\\.${S}?)*${PARTICLE}*${WORD}){1,2}${SUFFIX}`; // Marie-Claire Kambouchner
const PERSON = `(?:${APA}|${INITIALS_FIRST}|${FULL})`;
const LIST = `${PERSON}(?:(?:,${S}?(?:&${S}|and${S})?|${S}(?:and|&)${S})${PERSON})*`;
const MD = "(?:\\*{1,2}|_{1,2})?"; // a name may sit inside Markdown bold or italics

// Organizations look like full names but aren't people.
const ORG = /\b(?:University|College|Institute|Institution|Press|Society|Journal|Association|Foundation|Department|Center|Centre|Laboratory|Lab|Labs|Inc|Ltd|Company|Corporation|Group|Organization|Organisation|Agency|Service|Council|Academy|Museum|Library|Hospital|School|Board|Court|Survey|Review|Times|News|Post)\b/u;

const re = (src: string) => new RegExp(src, "gud");

// Each rule: a pattern, the capture group that holds the name (or list of names).
const RULES: { pattern: RegExp; group: number; list?: boolean }[] = [
  // Reference lists: every "Surname, I. I." is a person.
  { pattern: re(`(?<!\\p{L})(${APA})`), group: 1 },
  // Credit phrases.
  {
    pattern: re(`\\b(?:led|authored|co-authored|written|conducted|published|headed|directed|developed|proposed|described|reported|edited|compiled|run)${S}+by${S}+${MD}(?:(?:Dr|Prof|Professor)\\.?${S}+)?(${LIST})`),
    group: 1,
    list: true,
  },
  // A quoted or italic title, then "by" and the authors.
  {
    pattern: re(`(?:["“][^\\n"“”]{3,}["”]|\\*[^\\n*]{3,}\\*)[*_]{0,2}${S}*(?:\\(\\d{4}\\)${S}*)?by${S}+${MD}(${LIST})`),
    group: 1,
    list: true,
  },
  // Surname et al.
  { pattern: re(`(?<!\\p{L})(${SURNAME}),?${S}+et${S}+al\\b`), group: 1 },
  // Titles, before a full name ("Dr. Jane Smith"). Not a single word, and not
  // inside quotes, so the film "Dr. Strangelove" stays a film.
  { pattern: re(`(?<!["“*_])\\b(?:Dr|Prof|Professor)\\.?${S}+(${FULL})`), group: 1 },
  // Surname and colleagues.
  {
    pattern: re(`(?<!\\p{L})(${FULL}|${SURNAME})${S}+and${S}+(?:colleagues|co-?workers|co-?authors|(?:his|her|their)${S}+(?:colleagues|team))\\b`),
    group: 1,
  },
  // A job, then a full name: "researcher Jane Smith".
  {
    pattern: re(`\\b(?:researchers?|scientists?|psychologists?|neuroscientists?|economists?|biologists?|physicists?|chemists?|epidemiologists?|investigators?)${S}+(?:named${S}+|called${S}+)?(${FULL})`),
    group: 1,
  },
];

// In-text citations, "Fang (2015)" or "Blount and Kuhn (2016)": surnames only.
// A capitalized word right before means it's a full name or a heading
// ("Thomas Johann Seebeck (1821)", "Upon Release (1957)"), not a citation.
const IN_TEXT = re(`(?<!\\p{L})(${SURNAME})(?:${S}(?:and|&)${S}(${SURNAME}))?${S}\\(\\d{4}[a-z]?\\)`);
const CAPITALIZED_BEFORE = /\p{Lu}[\p{L}'’-]*\p{Ll}[^\S\n]$/u;

function trimmed(text: string, start: number, end: number): Span | null {
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  const name = text.slice(start, end);
  if (!name || ORG.test(name)) return null;
  return { start, end };
}

/** The parts of an answer to hide, as character positions in the original text. */
export function namesToHide(text: string): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number) => {
    const s = trimmed(text, start, end);
    if (s) spans.push(s);
  };
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      const range = m.indices?.[rule.group];
      if (!range) continue;
      const [s, e] = range;
      if (!rule.list) {
        add(s, e);
        continue;
      }
      for (const p of text.slice(s, e).matchAll(re(PERSON))) {
        const at = s + p.index!;
        add(at, at + p[0].length);
      }
    }
  }
  for (const m of text.matchAll(IN_TEXT)) {
    if (CAPITALIZED_BEFORE.test(text.slice(Math.max(0, m.index! - 40), m.index!))) continue;
    for (const g of [1, 2]) {
      const range = m.indices?.[g];
      if (range) add(range[0], range[1]);
    }
  }
  // In order, with overlaps merged.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** The text as the screen shows it, with every hidden name replaced by the marker. */
export function withNamesHidden(text: string, spans: Span[] = namesToHide(text)): string {
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + NAME_HIDDEN;
    at = s.end;
  }
  return out + text.slice(at);
}
