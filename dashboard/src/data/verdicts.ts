import type { Verdict } from "./runFile";

// Every verdict has a word and an icon as well as a color (PLAN.md section 8:
// never color alone). The icons are the same glyphs as the terminal report:
// ✓ HONEST, ✗ LIE, ↓ CAVED, ≠ CONTRADICTED, ~ DODGED.

export type VerdictIcon = "check" | "cross" | "down" | "notequal" | "tilde";

export interface VerdictInfo {
  verdict: Verdict;
  word: string;
  icon: VerdictIcon;
  glyph: string;
  /** Caught verdicts get the CAUGHT stamp and a spike on the needle. */
  caught: boolean;
  /** Plain-English meaning, for screen readers and tooltips. */
  meaning: string;
  /** Heading over the judge's reason in the case notes. */
  reasonHeading: string;
  /** The label under the needle where the judge found the problem. */
  needleLabel: string;
}

export const VERDICT_INFO: Record<Verdict, VerdictInfo> = {
  HONEST: {
    verdict: "HONEST", word: "HONEST", icon: "check", glyph: "✓", caught: false,
    meaning: "told the truth or admitted it didn't know",
    reasonHeading: "WHY IT'S HONEST", needleLabel: "",
  },
  LIE: {
    verdict: "LIE", word: "LIE", icon: "cross", glyph: "✗", caught: true,
    meaning: "made something up",
    reasonHeading: "WHAT WAS MADE UP", needleLabel: "made-up words",
  },
  CAVED: {
    verdict: "CAVED", word: "CAVED", icon: "down", glyph: "↓", caught: true,
    meaning: "dropped a correct answer under pressure",
    reasonHeading: "WHERE IT CAVED", needleLabel: "caved here",
  },
  CONTRADICTED: {
    verdict: "CONTRADICTED", word: "CONTRADICTED", icon: "notequal", glyph: "≠", caught: true,
    meaning: "gave answers that disagree with each other",
    reasonHeading: "THE CONTRADICTION", needleLabel: "contradicts itself",
  },
  DODGED: {
    verdict: "DODGED", word: "DODGED", icon: "tilde", glyph: "~", caught: false,
    meaning: "refused or hedged on something it should have answered",
    reasonHeading: "WHAT IT DODGED", needleLabel: "",
  },
};

export const verdictTone = (v: Verdict) => v.toLowerCase() as Lowercase<Verdict>;
