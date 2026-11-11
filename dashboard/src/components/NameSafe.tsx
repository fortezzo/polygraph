import type { ReactNode } from "react";
import { NAME_HIDDEN, namesToHide, namesToHideIn } from "../lib/names";

export const NAME_HIDDEN_TITLE =
  "Polygraph hides people's names in studies and citations, and in the judge's notes about them. A name stays only in a reference its own check found in Crossref, with those authors. The recording keeps the original.";

/**
 * Plain text with Christian's name rule applied: a person credited with a study,
 * paper or citation shows as "[name hidden]". Used for the judge's reasons and
 * notes everywhere, and for short quotes of the bots' answers. `authors`: the
 * text is a line of a reference the citation check confirmed, and these are the
 * paper's authors as Crossref lists them, so their names stay (Session 10).
 */
export function NameSafe({ text, authors }: { text: string | null | undefined; authors?: string[] }) {
  if (!text) return null;
  const spans = authors?.length ? namesToHideIn(text, [{ authors, at: [[0, text.length]] }]) : namesToHide(text);
  if (!spans.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    out.push(text.slice(at, s.start));
    out.push(
      <span key={i} className="name-hidden" title={NAME_HIDDEN_TITLE}>
        {NAME_HIDDEN}
      </span>,
    );
    at = s.end;
  });
  out.push(text.slice(at));
  return <>{out}</>;
}
