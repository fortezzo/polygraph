// Christian's rule (Session 6): on screen, people's names inside studies and
// citations that a bot made up are hidden behind a visible "[name hidden]".
// A bot that invents a study often pins it on a real-sounding person, and the
// dashboard shouldn't repeat that. The run files keep the original words.
//
// Where it applies (Session 10, Christian): every answer, whatever the verdict,
// because the judge can miss a lie. One exception: a name stays in a reference
// that Polygraph's own citation check confirmed (Crossref has the paper, with
// the title, authors and year the bot gave), if the name is one of the authors
// Crossref lists for it. See namesToHideIn(). The judge's notes always hide them.
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
//   Schuster R, Grewal N, Greaney GC           Vancouver style, in a reference
//   Bloom, Nicholas, James Liang, and …        Chicago style, starting a reference
//   **Authors:** Lei J, Ploner A               a label, then the authors
// History stays readable: "Thomas Johann Seebeck (1821)" or "Julius Caesar" on
// their own aren't credited with a study, so they're shown as written.

import type { TrapResult } from "../data/runFile";

export const NAME_HIDDEN = "[name hidden]";

export interface Span {
  start: number;
  end: number;
}

const S = "[^\\S\\n]"; // a space that isn't a line break: a name never crosses lines
const WORD = "\\p{Lu}[\\p{L}'’-]*\\p{Ll}"; // Kambouchner, O'Connor, McCann, Marie-Claire, Büchel
const PARTICLE = `(?:(?:van|von|der|den|de|da|di|del|della|du|la|le|bin|ibn)${S})`;
const SUFFIX = `(?:${S}(?:Jr|Sr|II|III|IV)\\.?)?`;
const INITIALS = `\\p{Lu}\\.(?:(?:${S}?|-)\\p{Lu}\\.){0,2}`; // K. I. · A.-M.
const SURNAME = `${PARTICLE}*${WORD}${SUFFIX}`;
const APA = `${SURNAME},${S}?${INITIALS}`; // Erickson, K. I.
const INITIALS_FIRST = `${INITIALS}${S}?(?:${WORD}${S})?${SURNAME}`; // K. I. Erickson, A. Bradford Hill
const FULL = `${WORD}(?:${S}(?:\\p{Lu}\\.${S}?)*${PARTICLE}*${WORD}){1,2}${SUFFIX}`; // Marie-Claire Kambouchner
const PERSON = `(?:${APA}|${INITIALS_FIRST}|${FULL})`;
const LIST = `${PERSON}(?:(?:,${S}?(?:&${S}|and${S})?|${S}(?:and|&)${S})${PERSON})*`;
const MD = "(?:\\*{1,2}|_{1,2})?"; // a name may sit inside Markdown bold or italics
const EMPH = "(?:\\*{1,2}|_{1,2})";

// Session 10: the other reference styles the bots use.
// Vancouver, common in medicine: a surname, then initials with no dots (Pope CA III).
// Not a word that takes a letter after it, like Vitamin D or Plan B.
const NOT_VANCOUVER =
  "(?:Vitamin|Hepatitis|Types?|Model|Plan|Phase|Stage|Grade|Class|Group|Section|Table|Figure|Fig|Level|Part|Unit|Series|Version|Category|Appendix|Chapter|Article|Option|Tier|Generation|Schedule|Exhibit|Volume|Vol|Issue|Supplement|Box|Panel|Item|Question|Step|Module|Factor|Protein|Gene|Region|Zone|Area|Block|Building|Room|Hall|Gate|Platform|Terminal|Flight|Route|Interstate|Highway|Channel|Studio|Windows|Office|World|War)";
// Nor capitals that are a word of their own, like Apple TV or Washington DC.
// (Only ones that can't be someone's initials: Vethaak AD and Smith AM are people.)
const NOT_INITIALS = "(?:TV|UK|US|USA|EU|GPS|USB|CEO|DNA|RNA|HIV|FDA|CDC|WHO|NASA|NHS|API|CPU|GPU|SUV)(?![\\p{L}\\d])";
const VANCOUVER = `(?!${NOT_VANCOUVER}${S})${PARTICLE}*${WORD}${S}(?!${NOT_INITIALS})\\p{Lu}{1,4}(?:${S}(?:Jr|Sr|II|III|IV))?(?![\\p{L}\\d])`;
const VANCOUVER_LIST = `${VANCOUVER}(?:,${S}?(?:&${S}|and${S})?${VANCOUVER})+`; // Schuster R, Grewal N, Greaney GC
// Chicago: the first author's surname first (Bloom, Nicholas · Madrian, Brigitte C. ·
// Barrero, Jose Maria), then the others. Not a word that starts a sentence ("However, Smith").
const OPENER =
  "(?:However|Moreover|Furthermore|Additionally|Also|Meanwhile|Similarly|Finally|First|Second|Third|Today|Here|There|Now|Then|Thus|Still|Yet|Indeed|Overall|Recently|Historically|Notably|Specifically|Importantly|Interestingly|Instead|Again|Later|Earlier|Previously|Subsequently|Unfortunately|Fortunately|Ultimately|Initially|Currently|Generally|Typically|Clearly|Perhaps|Yes|No|Well|Note|Sources|References|Summary|Example|Otherwise|Nevertheless|Nonetheless|Conversely|Alternatively|Consequently|Accordingly|Hence|Therefore|Briefly|Basically|Essentially|Traditionally|Originally|Eventually|Afterwards?|Elsewhere)(?![\\p{L}])";
const CHICAGO = `(?!${OPENER})${SURNAME},${S}${WORD}(?:${S}(?:${WORD}|\\p{Lu}\\.)){0,2}`;
// What comes right after a Chicago first author in a reference: more authors, et al., or the year.
// After a semicolon, the next author can be surname first too ("Holt-Lunstad, Julianne; Smith, Timothy B.").
const CHICAGO_NEXT = `(?=,${S}?(?:&${S}|and${S})?(?:${FULL}|${INITIALS_FIRST}|${APA})|;${S}?(?:&${S}|and${S})?(?:${FULL}|${INITIALS_FIRST}|${APA}|${CHICAGO})|${S}(?:and|&)${S}(?:${FULL}|${INITIALS_FIRST})|,?${S}+et${S}+al\\b|\\.${S}*\\(?(?:1[6-9]|20)\\d{2}\\b)`;
// Any author in a reference, in any of the styles.
// A full name goes before Vancouver, so "Richard H. Thaler" isn't read as "Richard H".
// In a list, initials can come with the name the person goes by: "Syme, S. Leonard".
const APA_GIVEN = `${APA}(?:${S}${WORD}(?=[,;.)]|${S}(?:and|&)${S}|$))?`; // $: the end of a list being split
const AUTHOR = `(?:${APA_GIVEN}|${CHICAGO}|${INITIALS_FIRST}|${FULL}|${VANCOUVER})`;
const AUTHOR_LIST = `${AUTHOR}(?:(?:[,;]${S}?(?:&${S}|and${S})?|${S}(?:and|&)${S})${AUTHOR})*`;
// The start of a line in a reference list: a bullet or number, bold, a label like "**Citation:**".
const LEAD = `(?:^|\\n)${S}*(?:(?:[-*+]|\\d+[.)])${S}+)?${EMPH}?(?:\\d+[.)]${S}*)?(?:${EMPH}?\\p{L}[\\p{L} ]{0,24}(?::${EMPH}?|${EMPH}:)${S}*)?${EMPH}?`;
// A line that reads like a reference: a year (or "forthcoming"), et al., a DOI or an authors label.
const CITATION_LINE = /(?<!\d)(?:1[6-9]|20)\d{2}(?!\d)|\bforthcoming\b|\bin\s+press\b|\bet\s+al\b|\bdoi\b|\b(?:authors?|citation|reference)s?\b/iu;

// Organizations look like full names but aren't people.
const ORG = /\b(?:University|College|Institute|Institution|Press|Society|Journal|Association|Foundation|Department|Center|Centre|Laboratory|Lab|Labs|Inc|Ltd|Company|Corporation|Group|Organization|Organisation|Agency|Service|Council|Academy|Museum|Library|Hospital|School|Board|Court|Survey|Review|Times|News|Post|Collaboration|Collaborative|Consortium|Committee|Network|Initiative|Project|Programme|Program|Commission|Ministry|Bureau|Federation|Alliance|Coalition|Study|Trial|Trialists)\b/u;

const re = (src: string) => new RegExp(src, "gud");

// Each rule: a pattern, the capture group that holds the name (or list of names),
// the pattern for one person in that list, whether the line has to read like a
// reference (a year, et al., a DOI or an authors label), and whether it's a
// citation (`cites`): then the surname is hidden wherever else the answer
// repeats it ("Madrian and Shea analyzed…", Session 10). A credit phrase isn't:
// "written by Jane Austen" doesn't hide every later "Austen".
const RULES: { pattern: RegExp; group: number; each?: string; citation?: boolean; cites?: boolean }[] = [
  // Reference lists: every "Surname, I. I." is a person.
  { pattern: re(`(?<!\\p{L})(${APA})`), group: 1, cites: true },
  // Credit phrases.
  {
    pattern: re(`\\b(?:led|authored|co-authored|written|conducted|published|headed|directed|developed|proposed|described|reported|edited|compiled|run)${S}+by${S}+${MD}(?:(?:Dr|Prof|Professor)\\.?${S}+)?(${LIST})`),
    group: 1,
    each: PERSON,
  },
  // A quoted or italic title, then "by" and the authors.
  {
    pattern: re(`(?:["“][^\\n"“”]{3,}["”]|\\*[^\\n*]{3,}\\*)[*_]{0,2}${S}*(?:\\(\\d{4}\\)${S}*)?by${S}+${MD}(${LIST})`),
    group: 1,
    each: PERSON,
  },
  // Vancouver style: two or more authors in a reference, or one before et al.
  { pattern: re(`(?<![\\p{L}\\d])(${VANCOUVER_LIST})`), group: 1, each: VANCOUVER, citation: true, cites: true },
  { pattern: re(`(?<![\\p{L}\\d])(${VANCOUVER}),?${S}+et${S}+al\\b`), group: 1, cites: true },
  // Chicago style, starting a reference, with more authors, et al. or the year after it.
  {
    pattern: re(`${LEAD}(${CHICAGO}${CHICAGO_NEXT}(?:(?:[,;]${S}?(?:&${S}|and${S})?|${S}(?:and|&)${S})${AUTHOR})*)`),
    group: 1,
    each: AUTHOR,
    citation: true,
    cites: true,
  },
  // A label, then the authors: "**Authors:** Lei J, Ploner A".
  {
    pattern: re(`\\b(?:Authors?|Author\\(s\\)|Co-?authors?|Researchers|Investigators)${EMPH}?:${EMPH}?${S}*${EMPH}?(${AUTHOR_LIST})`),
    group: 1,
    each: AUTHOR,
    cites: true,
  },
  // Surname et al.
  { pattern: re(`(?<!\\p{L})(${SURNAME}),?${S}+et${S}+al\\b`), group: 1, cites: true },
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

function lineAt(text: string, at: number): string {
  const end = text.indexOf("\n", at);
  return text.slice(text.lastIndexOf("\n", at - 1) + 1, end < 0 ? text.length : end);
}

function trimmed(text: string, start: number, end: number): Span | null {
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  const name = text.slice(start, end);
  if (!name || ORG.test(name)) return null;
  return { start, end };
}

/** One person's name, as a rule found it. */
interface Found extends Span {
  cites: boolean;
}

/** Every name the rules find, one person at a time, before overlaps are merged. */
function found(text: string): Found[] {
  const out: Found[] = [];
  const add = (start: number, end: number, cites: boolean) => {
    const s = trimmed(text, start, end);
    if (s) out.push({ ...s, cites });
  };
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      const range = m.indices?.[rule.group];
      if (!range) continue;
      const [s, e] = range;
      if (rule.citation && !CITATION_LINE.test(lineAt(text, s))) continue;
      if (!rule.each) {
        add(s, e, !!rule.cites);
        continue;
      }
      for (const p of text.slice(s, e).matchAll(re(rule.each))) {
        const at = s + p.index!;
        add(at, at + p[0].length, !!rule.cites);
      }
    }
  }
  for (const m of text.matchAll(IN_TEXT)) {
    if (CAPITALIZED_BEFORE.test(text.slice(Math.max(0, m.index! - 40), m.index!))) continue;
    for (const g of [1, 2]) {
      const range = m.indices?.[g];
      // Not a source of repeats: "Battle of Towton (1461)" reads the same way.
      if (range) add(range[0], range[1], false);
    }
  }
  return out;
}

// Surnames that are everyday words too: a repeat of one of these isn't hidden.
const EVERYDAY = new Set(
  ("Born May Will Long Young White Black Green Brown Gray Grey Rose Hope Love Bell King Price Rich Hall Park Lane Stone " +
    "Wood Field Sharp Strong Swift Wise Moon Day Case Mark Chase Cook Hunt Ford Page Bush Rice Cash Banks Major Little " +
    "Small Short Hardy Noble Bright Good Best North South East West English French German Church Bishop Judge Mayor Power").split(" "),
);

/** The surname in one person's name: first in "Erickson, K. I." or "Schuster R", last in "Jane Smith". */
function surnameOf(name: string): string | null {
  const first = name.match(new RegExp(`^${PARTICLE}*(${WORD})(?:${SUFFIX},|,|${S}\\p{Lu}{1,4}(?:${S}(?:Jr|Sr|II|III|IV))?$)`, "u"));
  if (first) return first[1]!;
  const words = name.match(new RegExp(WORD, "gu"))?.filter((w) => !/^(?:Jr|Sr)$/.test(w)) ?? [];
  return words.length ? words[words.length - 1]! : null;
}

/** Where the answer repeats the surname of a person a citation names, as a whole word. */
function repeats(text: string, cited: Found[]): Span[] {
  const surnames = new Set<string>();
  for (const f of cited) {
    const s = surnameOf(text.slice(f.start, f.end));
    if (s && s.length >= 3 && !EVERYDAY.has(s)) surnames.add(s);
  }
  const out: Span[] = [];
  for (const s of surnames) {
    const word = new RegExp(`(?<![\\p{L}\\p{N}])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of text.matchAll(word)) out.push({ start: m.index!, end: m.index! + s.length });
  }
  return out;
}

/** In order, with overlaps merged. */
function merged(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/** The parts of an answer to hide, as character positions in the original text. */
export function namesToHide(text: string): Span[] {
  return namesToHideIn(text);
}

/**
 * A reference Polygraph's citation check confirmed (added by export-runs.mjs):
 * the paper's authors as Crossref lists them (family names), and where the
 * reference's lines are in the answer the check read (the trap's first answer).
 */
export interface ConfirmedReference {
  authors: string[];
  at: [number, number][];
}

const SUFFIX_WORDS = new Set(["jr", "sr", "ii", "iii", "iv"]);
const wordsOf = (s: string) =>
  (s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => !SUFFIX_WORDS.has(w));

/** Is this name one of the paper's authors? Its surname, as Crossref spells it, is one of the name's words. */
function isAuthor(name: string, authors: string[]): boolean {
  const words = new Set(wordsOf(name));
  return authors.some((a) => {
    const surname = wordsOf(a).pop();
    return !!surname && surname.length >= 2 && words.has(surname);
  });
}

/**
 * The names to hide in an answer, whatever its verdict (Christian, Session 10).
 * Only a name inside a reference the citation check confirmed, and one of that
 * paper's authors, stays shown. That's decided one person at a time. Pass
 * `confirmed` for the answer the check read (the trap's first answer) and
 * nothing for any other.
 */
export function namesToHideIn(text: string, confirmed: readonly ConfirmedReference[] = []): Span[] {
  const shown = (s: Span) =>
    confirmed.some((c) => c.at.some(([a, b]) => s.start >= a && s.end <= b) && isAuthor(text.slice(s.start, s.end), c.authors));
  const hidden = found(text).filter((f) => !shown(f));
  const again = repeats(text, hidden.filter((f) => f.cites)).filter((s) => !shown(s));
  return merged([...hidden, ...again]);
}

/** The references in a trap that Polygraph's citation check confirmed: they apply to its first answer. */
export function confirmedIn(trap: TrapResult): ConfirmedReference[] {
  return (trap.judgement?.hard_check?.details?.references ?? []).flatMap((r) => (r.confirmed ? [r.confirmed] : []));
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
