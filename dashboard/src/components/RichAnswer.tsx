import { Fragment, useMemo, type ReactNode } from "react";
import { lastVisibleIn, parseAnswer, piecesOf, type Line } from "../lib/markdown";
import { excerptRange } from "../lib/excerpt";
import { NAME_HIDDEN, type Span } from "../lib/names";
import type { Tone } from "../lib/timeline";
import { VERDICT_INFO } from "../data/verdicts";
import { Icon } from "./Icon";
import { NAME_HIDDEN_TITLE } from "./NameSafe";

const TAG: Record<Tone, { words: string; verdict: "LIE" | "CAVED" | "CONTRADICTED"; cls: string }> = {
  lie: { words: "MADE UP", verdict: "LIE", cls: "text-lie-ink border-lie-ink" },
  caved: { words: "CAVED", verdict: "CAVED", cls: "text-caved-ink border-caved-ink" },
  contradicted: { words: "CONTRADICTS", verdict: "CONTRADICTED", cls: "text-contradicted-ink border-contradicted-ink" },
};

/**
 * A bot's answer on paper: Markdown shown as formatting, the judge's made-up
 * phrase marked in ink with a tag, and hidden names as "[name hidden]".
 * With `excerpt`, only the paragraphs around the made-up words.
 */
export function RichAnswer({
  text, hot, hidden = [], excerpt = false,
}: { text: string; hot: { start: number; end: number; tone: Tone } | null; hidden?: Span[]; excerpt?: boolean }) {
  const blocks = useMemo(() => parseAnswer(text), [text]);
  const tagAt = useMemo(() => lastVisibleIn(blocks, hot), [blocks, hot]);
  const range = excerpt ? excerptRange(blocks, hot) : { first: 0, last: blocks.length - 1, before: false, after: false };
  const markers = new Set<number>();

  const renderLine = (line: Line) =>
    piecesOf(line, Number.MAX_SAFE_INTEGER, hot, hidden).map((p) => {
      const out: ReactNode[] = [];
      const hotCls = p.hot && hot ? `hot-${hot.tone}` : "";
      if (p.hidden !== null) {
        if (!markers.has(p.hidden)) {
          markers.add(p.hidden);
          out.push(<span key={p.start} className={`name-hidden ${hotCls}`} title={NAME_HIDDEN_TITLE}>{NAME_HIDDEN}</span>);
        }
      } else {
        const cls = [p.marks.includes("b") ? "font-bold" : "", p.marks.includes("i") ? "italic" : "", p.marks.includes("code") ? "rounded-sm bg-black/5 px-0.5" : "", hotCls]
          .filter(Boolean)
          .join(" ");
        out.push(<span key={p.start} className={cls || undefined}>{p.text}</span>);
      }
      if (hot && tagAt !== null && tagAt >= p.start && tagAt < p.start + p.text.length) {
        const tag = TAG[hot.tone];
        out.push(
          <span key={`t${p.start}`} className={`ml-1.5 inline-flex items-center gap-1 rounded-[2px] border px-1.5 align-[1px] font-label text-[10.5px] leading-[17px] tracking-[0.1em] ${tag.cls}`}>
            <Icon name={VERDICT_INFO[tag.verdict].icon} className="h-2.5 w-2.5" strokeWidth={3.2} />
            {tag.words}
          </span>,
        );
      }
      return out;
    });

  const Cut = () => <p className="my-1 text-[13px] tracking-[0.2em] text-manila-label" aria-label="Part of the answer is left out here">[…]</p>;

  return (
    <div className="on-paper text-[14.5px] leading-[1.58]">
      {range.before && <Cut />}
      {blocks.slice(range.first, range.last + 1).map((b, bi) => {
        if (b.kind === "li") {
          return (
            <div key={bi} className="mb-1 flex gap-2" style={{ paddingLeft: `${b.level * 1.1}rem` }}>
              <span className="w-5 shrink-0 text-right">{b.bullet}</span>
              <span className="min-w-0 whitespace-pre-wrap">{renderLine(b.lines[0] ?? [])}</span>
            </div>
          );
        }
        const Tag = b.kind === "pre" ? "pre" : "p";
        return (
          <Tag key={bi} className={`mb-2 whitespace-pre-wrap ${b.kind === "h" ? "font-bold" : ""} ${b.kind === "pre" ? "overflow-x-auto rounded bg-black/5 p-2 text-[13px]" : ""}`}>
            {b.lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {renderLine(l)}
              </Fragment>
            ))}
          </Tag>
        );
      })}
      {range.after && <Cut />}
    </div>
  );
}
