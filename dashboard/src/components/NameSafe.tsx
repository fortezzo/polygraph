import type { ReactNode } from "react";
import { NAME_HIDDEN, namesToHide } from "../lib/names";

export const NAME_HIDDEN_TITLE =
  "Polygraph hides people's names in studies and citations a bot made up, and in the judge's notes about them. The recording keeps the original.";

/**
 * Plain text with Christian's name rule applied: a person credited with a study,
 * paper or citation shows as "[name hidden]". Used for the judge's reasons and
 * notes everywhere, and for short quotes of the bots' answers.
 */
export function NameSafe({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  const spans = namesToHide(text);
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
