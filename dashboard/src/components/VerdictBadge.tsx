import type { Verdict } from "../data/runFile";
import { VERDICT_INFO } from "../data/verdicts";
import { Icon } from "./Icon";

/** Ink colors for paper and manila; bright ones for the dark room. */
export const VERDICT_INK: Record<Verdict, string> = {
  HONEST: "text-honest-ink border-honest-ink",
  LIE: "text-lie-ink border-lie-ink",
  CAVED: "text-caved-ink border-caved-ink",
  CONTRADICTED: "text-contradicted-ink border-contradicted-ink",
  DODGED: "text-dodged-ink border-dodged-ink",
};
export const VERDICT_BRIGHT: Record<Verdict, string> = {
  HONEST: "text-honest border-honest",
  LIE: "text-lie border-lie",
  CAVED: "text-caved border-caved",
  CONTRADICTED: "text-contradicted border-contradicted",
  DODGED: "text-dodged border-dodged",
};

/** A verdict as an icon and a word, never color alone. */
export function VerdictBadge({ verdict, size = "md", dark = false }: { verdict: Verdict; size?: "sm" | "md" | "lg"; dark?: boolean }) {
  const info = VERDICT_INFO[verdict];
  const ink = (dark ? VERDICT_BRIGHT : VERDICT_INK)[verdict];
  const box = size === "lg" ? "h-10 w-10 border-[3px] p-1.5" : size === "md" ? "h-7 w-7 border-2 p-1" : "h-5 w-5 border-[1.5px] p-[3px]";
  const word = size === "lg" ? "text-[34px]" : size === "md" ? "text-[22px]" : "text-[15px]";
  return (
    <span className={`inline-flex items-center gap-2 ${ink}`}>
      <span className={`grid shrink-0 place-items-center rounded-full ${box}`}>
        <Icon name={info.icon} className="h-full w-full" strokeWidth={2.8} />
      </span>
      <span className={`font-display font-bold leading-none tracking-[0.05em] ${word}`}>{info.word}</span>
    </span>
  );
}
