import { useEffect, type CSSProperties, type ReactNode } from "react";
import { TRAP_TYPES, shownScore } from "../lib/report";
import { hrefFor } from "../lib/route";
import {
  cutOffWords,
  day,
  leanShort,
  leanWords,
  overlapping,
  panelLeanWords,
  ranks,
  sideName,
  stateDetail,
  stateHeadline,
  thinkingWords,
  wallOrder,
  type DiffRow,
  type LineupBot,
  type LineupData,
  type LineupJudge,
  type LineupPair,
  type PairSide,
  scoreWords,
} from "../lib/lineup";
import { NameSafe } from "./NameSafe";
import { VerdictBadge } from "./VerdictBadge";

// The lineup (Session 9). Christian's rules for it: the same numbers for every
// judge, a judge that missed the line set in advance says so plainly, every
// bot on its default settings (the thinking level shown), cut-off answers
// counted, no logos, and "[name hidden]" wherever a bot's words could carry a
// made-up study's author (NameSafe).

const Key = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`font-label text-[11.5px] tracking-[0.18em] text-manila-label ${className}`}>{children}</div>
);

const LINK = "text-manila-ink underline decoration-manila-label/60 underline-offset-2 hover:decoration-manila-ink";

/** The id of a judge's card, for "The judge →" links. */
export const judgeAnchor = (judge: string) => `judge-${judge.replace(/[^a-z0-9]+/gi, "-")}`;

const clamp = (n: number) => Math.max(0, Math.min(100, n));

const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** "DODGED" -> "Dodged". */
const verdictWord = (v: string) => v.charAt(0) + v.slice(1).toLowerCase();

/** Christian's check of verdicts the judge marked as caught, outside the test half (Session 9). */
function SpotCheck({ check: c }: { check: NonNullable<LineupJudge["spot_check"]> }) {
  const all = c.honest_vs_caught !== null && c.honest_vs_caught === c.answers;
  return (
    <div className="mt-3 border-t border-dashed border-manila-label/45 pt-3 text-[14px] leading-snug">
      <p className="m-0">
        <b>Christian&rsquo;s spot check{c.checked_on ? ` (${day(c.checked_on)})` : ""}:</b> of {c.answers} random verdicts it
        marked as caught{c.on ? ` on ${c.on}` : ""}, he agreed with {c.same_verdict}
        {all ? `, and with all ${c.answers} that the answer wasn’t honest` : ""}.
      </p>
      {c.disagreed.map((d) => (
        <p key={`${d.bot}-${d.trap}`} className="mt-1.5 mb-0">
          He called {d.bot}&rsquo;s {d.trap} {verdictWord(d.christian)}, not {verdictWord(d.judge)}
          {d.why ? `: ${d.why}` : "."}
        </p>
      ))}
      {c.different_reason.map((d) => (
        <p key={`${d.bot}-${d.trap}-reason`} className="mt-1.5 mb-0">
          {d.bot}&rsquo;s {d.trap}: the same verdict ({verdictWord(d.verdict)}), for a different reason. {d.why}
        </p>
      ))}
      {c.decision && <p className="mt-1.5 mb-0">{c.decision}</p>}
    </div>
  );
}

/** The whole lineup screen, from the export's data. */
export function LineupView({ lineup, focusJudge }: { lineup: LineupData; focusJudge?: string | null }) {
  const bots = wallOrder(lineup.bots);
  const place = ranks(lineup.bots);
  const scored = bots.filter((b) => b.state === "scored");
  const holdJudge = lineup.hold?.judges[0] ?? null;
  const waiting = bots.filter((b) => b.waiting_for_judge && b.state !== "scored");

  // "The judge →" on a placard opens its card in the judges panel.
  useEffect(() => {
    if (!focusJudge) return;
    const el = document.getElementById(judgeAnchor(focusJudge));
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [focusJudge]);

  return (
    <section aria-labelledby="lineup-title" className="flex flex-col gap-9">
      <header className="max-w-[880px]">
        <div className="font-label text-[13px] tracking-[0.14em] text-brass">THE LINEUP</div>
        <h1 id="lineup-title" className="mt-1 mb-0 font-display text-[30px] leading-tight font-semibold tracking-[0.03em] text-[#f3e8d2] sm:text-[38px]">
          {lineup.traps ? `Every bot, the same ${lineup.traps} trap questions` : "Every bot, the same trap questions"}
        </h1>
        <p className="mt-2 mb-0 text-[15px] leading-relaxed text-soft">
          Each bot stands as tall as its Truth Score: out of 100, how honest its answers were, with a dodge counting as half a miss. The box at the
          end of each bar is its 95% range. Every bot ran on its own default settings.
        </p>
      </header>

      {lineup.hold && waiting.length > 0 && (
        <aside aria-label="Judge being chosen" className="flex max-w-[980px] flex-col gap-2 rounded-[4px] border border-lie/50 bg-lie/[0.07] px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
          <span className="shrink-0 font-label text-[13px] tracking-[0.14em] text-lie">{(lineup.hold.headline ?? "Judge being chosen").toUpperCase()}</span>
          <p className="m-0 text-[14.5px] leading-relaxed text-soft">
            {lineup.hold.why}
            {lineup.hold.since ? ` On hold since ${day(lineup.hold.since)}.` : ""}{" "}
            {holdJudge && (
              <a href={hrefFor("lineup", { judge: holdJudge })} className="text-brass underline underline-offset-2">
                The judges
              </a>
            )}
          </p>
        </aside>
      )}

      <div>
        <HeightWall bots={bots} place={place} traps={lineup.traps} holdHeadline={lineup.hold?.headline ?? null} holdJudge={holdJudge} />
        <ul className="mt-3 mb-0 flex max-w-[980px] list-none flex-col gap-1 p-0 text-[13.5px] leading-relaxed text-muted">
          {scored.length > 1 && overlapping(lineup.bots) && (
            <li>Where two bots&rsquo; ranges overlap, their order could swap with a different set of questions: the gap between them is smaller than the uncertainty.</li>
          )}
          <li>
            A bot is never graded by a judge from its own company. Each judge was checked against Christian&rsquo;s own labels first: see the judges, below.
          </li>
        </ul>
      </div>

      <JudgesPanel judges={lineup.judges} focus={focusJudge ?? null} />

      {lineup.pairs.length > 0 && (
        <section aria-labelledby="pairs-title" className="flex flex-col gap-5">
          <div className="max-w-[880px]">
            <h2 id="pairs-title" className="m-0 font-display text-[26px] font-semibold tracking-[0.03em] text-[#f3e8d2]">
              Side by side
            </h2>
            <p className="mt-1 mb-0 text-[15px] leading-relaxed text-soft">Two bots on the same traps, and every trap where their verdicts differ.</p>
          </div>
          {lineup.pairs.map((p) => (
            <SideBySide key={p.id} pair={p} />
          ))}
        </section>
      )}
    </section>
  );
}

// --- The wall -----------------------------------------------------------------------------------

export function HeightWall({
  bots, place, traps, holdHeadline, holdJudge,
}: { bots: LineupBot[]; place: Map<string, number>; traps: number | null; holdHeadline: string | null; holdJudge: string | null }) {
  return (
    <div className="lineup-wall chart-panel" style={{ "--slots": bots.length } as CSSProperties}>
      <div className="lineup-marks" aria-hidden="true">
        {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((n) => (
          <span key={n} className={n % 50 === 0 ? "major" : undefined} style={{ bottom: `${n}%` }}>
            <b>{n}</b>
          </span>
        ))}
      </div>
      <ol className="lineup-slots" aria-label="The lineup, highest Truth Score first">
        {bots.map((b) => (
          <li key={b.model} className="lineup-slot" data-state={b.state}>
            <Meter bot={b} holdHeadline={holdHeadline} />
            <Placard bot={b} place={place.get(b.model) ?? null} traps={traps} holdHeadline={holdHeadline} holdJudge={holdJudge} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The bar: the bot's height on the chart. Decorative: its placard says the same in words. */
function Meter({ bot, holdHeadline }: { bot: LineupBot; holdHeadline: string | null }) {
  const s = bot.score;
  if (!s) {
    return (
      <div className="lineup-meter" aria-hidden="true">
        <div className="lm-pending">
          <span className="lm-q">?</span>
          <span>{stateHeadline(bot, holdHeadline)}</span>
        </div>
      </div>
    );
  }
  const [lo, hi] = s.interval ?? [s.overall, s.overall];
  const style = { "--score": clamp(s.overall), "--lo": clamp(lo), "--hi": clamp(hi) } as CSSProperties;
  return (
    <div className="lineup-meter" style={style} aria-hidden="true">
      <div className="lm-axis" />
      <div className="lm-range" />
      <div className="lm-bar" />
      <div className="lm-score">{shownScore(s.overall)}</div>
      <div className="lm-ticks">
        <span style={{ left: "0%" }}>0</span>
        <span style={{ left: "50%" }}>50</span>
        <span style={{ left: "100%" }}>100</span>
      </div>
    </div>
  );
}

/** The card each bot holds up: who it is, its score (or why it has none), and how it was judged. */
export function Placard({
  bot, place, traps, holdHeadline, holdJudge,
}: { bot: LineupBot; place: number | null; traps: number | null; holdHeadline: string | null; holdJudge: string | null }) {
  const s = bot.score;
  const m = bot.judge?.measured ?? null;
  const thinking = thinkingWords(bot.thinking);
  const cut = cutOffWords(bot.cut_off);
  const why = bot.held_by ?? (bot.waiting_for_judge ? holdJudge : null);
  const sub = [bot.maker, bot.size].filter(Boolean).join(" · ");
  return (
    <article className="placard manila" aria-labelledby={`placard-${judgeAnchor(bot.model)}`}>
      <div className="font-label text-[12px] tracking-[0.14em] text-manila-label">{place ? `NO. ${place}` : "NO SCORE"}</div>
      <h3
        id={`placard-${judgeAnchor(bot.model)}`}
        className="m-0 font-display text-[18px] leading-tight font-semibold [overflow-wrap:anywhere] text-manila-ink"
      >
        {bot.model}
      </h3>
      {sub && (
        <div className="text-[12.5px] text-manila-label">
          <span className="sr-only">Made by </span>
          {sub}
        </div>
      )}

      {s ? (
        <div className="mt-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="sr-only">Truth Score </span>
            <span className="font-display text-[34px] leading-none font-bold text-manila-ink">{shownScore(s.overall)}</span>
            {s.margin_of_error !== null && <span className="ml-1 font-display text-[16px] font-bold whitespace-nowrap">± {shownScore(s.margin_of_error)}</span>}
            {s.interval && (
              <div className="text-[12px] text-manila-label">
                95% range {shownScore(s.interval[0])}–{shownScore(s.interval[1])}
              </div>
            )}
          </div>
          <div className="stamp-ink shrink-0 rotate-[-8deg] px-1.5 pt-0.5 pb-1 text-[30px] leading-[0.9]" aria-label={`Grade ${s.grade}`}>
            {s.grade}
          </div>
        </div>
      ) : (
        <div className="mt-2">
          <div className="font-label text-[13px] tracking-[0.12em] text-lie-ink uppercase">{stateHeadline(bot, holdHeadline)}</div>
          <p className="mt-1 mb-0 text-[12.5px] leading-snug">{stateDetail(bot, traps)}</p>
        </div>
      )}

      {(bot.judge || bot.held_by || bot.second_opinion || thinking || cut) && (
        <ul className="mt-2.5 mb-0 list-none space-y-1 border-t border-dashed border-manila-label/45 p-0 pt-2 text-[12.5px] leading-snug">
          {bot.judge && (
            <li>
              Judge: <b className="[overflow-wrap:anywhere]">{bot.judge.model}</b>
              {bot.judge.company ? ` (${bot.judge.company})` : ""}
            </li>
          )}
          {bot.judge && (
            <li>{m ? `Matched Christian on ${m.agree} of ${m.answers} (${m.percent}%)` : "Not checked against Christian's labels"}</li>
          )}
          {m && <li title={`${leanWords(m)}.`}>{leanShort(m)}</li>}
          {bot.held_by && <li>Graded by {bot.held_by}: on hold</li>}
          {bot.second_opinion && (
            <li>
              Second opinion: <span className="[overflow-wrap:anywhere]">{bot.second_opinion.judge}</span> gave it{" "}
              <b className="whitespace-nowrap">{scoreWords(bot.second_opinion.score)}</b>
            </li>
          )}
          {thinking && <li>{thinking}</li>}
          {cut && <li>{cut}</li>}
        </ul>
      )}

      {(bot.run_id || why || bot.judge) && (
        <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
          {bot.state === "scored" && bot.run_id && (
            <a href={hrefFor("report", { run: bot.run_id })} className={LINK}>
              Report card →
            </a>
          )}
          {bot.judge && (
            <a href={hrefFor("lineup", { judge: bot.judge.model })} className={LINK}>
              The judge →
            </a>
          )}
          {!bot.judge && why && (
            <a href={hrefFor("lineup", { judge: why })} className={LINK}>
              Why no score →
            </a>
          )}
        </div>
      )}
    </article>
  );
}

// --- The judges ------------------------------------------------------------------------------------

export function JudgesPanel({ judges, focus }: { judges: LineupJudge[]; focus: string | null }) {
  if (!judges.length) return null;
  return (
    <section aria-labelledby="judges-title" className="flex flex-col gap-5">
      <div className="max-w-[880px]">
        <h2 id="judges-title" className="m-0 font-display text-[26px] font-semibold tracking-[0.03em] text-[#f3e8d2]">
          The judges
        </h2>
        <p className="mt-1 mb-0 text-[15px] leading-relaxed text-soft">
          Before grading the lineup, each judge graded the same 50 answers Christian had labeled by hand, without seeing his labels. Here are the
          same numbers for each.
        </p>
      </div>
      <div className="grid items-start gap-7 pt-2 lg:grid-cols-2">
        {judges.map((j) => (
          <JudgeCard key={j.judge} judge={j} focused={focus === j.judge} />
        ))}
      </div>
    </section>
  );
}

export function JudgeCard({ judge: j, focused }: { judge: LineupJudge; focused: boolean }) {
  const m = j.measured;
  const role = j.grades.length
    ? `Grades ${list(j.grades)}.`
    : j.second_opinion_for.length
      ? `A second opinion on ${list(j.second_opinion_for)}.`
      : j.held_bots.length
        ? `Graded ${list(j.held_bots)}.`
        : j.replaced
          ? `Replaced${j.replaced.by ? ` by ${j.replaced.by}` : ""}: its grades don't count.`
          : "Grades no bot in the lineup right now.";
  return (
    <article
      id={judgeAnchor(j.judge)}
      className="judge-card card-paper relative scroll-mt-6 rounded-[3px] px-5 pt-6 pb-5 sm:px-6"
      data-focus={focused ? "" : undefined}
      aria-labelledby={`${judgeAnchor(j.judge)}-name`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Key>JUDGE{j.company ? ` · MADE BY ${j.company.toUpperCase()}` : ""}</Key>
          <h3 id={`${judgeAnchor(j.judge)}-name`} className="m-0 font-display text-[24px] leading-tight font-semibold break-words text-manila-ink">
            {j.judge}
          </h3>
        </div>
        {j.hold && <div className="stamp-ink mt-1 shrink-0 rotate-[-6deg] px-2.5 pt-1 pb-1.5 text-[20px]">ON HOLD</div>}
        {j.replaced && <div className="stamp-ink mt-1 shrink-0 rotate-[-6deg] px-2.5 pt-1 pb-1.5 text-[20px]">REPLACED</div>}
      </div>
      <p className="mt-2 mb-0 text-[14.5px] leading-snug">{role}</p>

      {m ? (
        <>
          <table className="mt-3 w-full border-collapse text-[14px]">
            <caption className="sr-only">How {j.judge} did on Christian&rsquo;s 50 test answers</caption>
            <tbody>
              <tr className="border-b border-dashed border-manila-label/35">
                <th scope="row" className="py-1.5 pr-3 text-left align-top font-normal">Same verdict as Christian</th>
                <td className="py-1.5 text-right align-top">
                  <b className="font-display text-[18px]">
                    {m.agree} of {m.answers}
                  </b>{" "}
                  ({m.percent}%)
                  {m.percent_range && (
                    <div className="text-[12px] text-manila-label">
                      95% range {m.percent_range[0]}–{m.percent_range[1]}%
                    </div>
                  )}
                </td>
              </tr>
              <tr className="border-b border-dashed border-manila-label/35">
                <th scope="row" className="py-1.5 pr-3 text-left align-top font-normal">
                  Honest vs caught: the same points as his label
                  <div className="text-[12px] text-manila-label">what the Truth Score counts</div>
                </th>
                <td className="py-1.5 text-right align-top">
                  {m.honest_vs_caught === null ? "–" : (
                    <b className="font-display text-[18px]">
                      {m.honest_vs_caught} of {m.answers}
                    </b>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row" className="py-1.5 pr-3 text-left align-top font-normal">
                  Score it gives the 50 answers
                  {m.score_of_the_50.labels !== null && <div className="text-[12px] text-manila-label">by Christian&rsquo;s labels: {m.score_of_the_50.labels}</div>}
                </th>
                <td className="py-1.5 text-right align-top">
                  <b className="font-display text-[18px]">{m.score_of_the_50.judge ?? "–"}</b>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 mb-0 text-[13.5px] leading-snug">{panelLeanWords(m.lean)}</p>
        </>
      ) : (
        <p className="mt-3 mb-0 text-[14px]">It hasn&rsquo;t been checked against Christian&rsquo;s labels, so how far to trust it isn&rsquo;t known.</p>
      )}

      {j.line && m && (
        <p className="mt-3 mb-0 text-[14px] leading-snug">
          <b>The line set in advance:</b> {j.line.agree} of {j.line.answers} ({j.line.percent}%).{" "}
          {j.line.passed ? "It passed." : `It got ${m.agree}, so it missed the line.`}
        </p>
      )}
      {j.line && !j.line.passed && j.decision && j.decision.why.length > 0 && (
        <div className="mt-2 text-[13.5px] leading-snug">
          <b>Why it was used anyway</b> (Christian&rsquo;s decision):
          <ul className="mt-1 mb-0 list-disc space-y-1 pl-5">
            {j.decision.why.map((w, i) => (
              <li key={i}>
                <NameSafe text={w} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {j.hold && (
        <p className="mt-3 mb-0 border-l-4 border-lie-ink pl-3 text-[14px] leading-snug">
          <b>On hold{j.hold.since ? ` since ${day(j.hold.since)}` : ""}.</b> {j.hold.why}
        </p>
      )}
      {j.replaced && (
        <p className="mt-3 mb-0 border-l-4 border-lie-ink pl-3 text-[14px] leading-snug">
          <b>
            Replaced{j.replaced.since ? ` on ${day(j.replaced.since)}` : ""}
            {j.replaced.by ? ` by ${j.replaced.by}` : ""}.
          </b>{" "}
          {j.replaced.why}
        </p>
      )}
      {j.spot_check && <SpotCheck check={j.spot_check} />}
      {j.versus && j.versus.agree !== null && (
        <p className="mt-3 mb-0 text-[13.5px] leading-snug">
          It and {j.versus.other} gave the same verdict on {j.versus.agree} of {j.versus.answers} of those answers ({j.versus.percent}%).
        </p>
      )}
      {m && (
        <p className="mt-3 mb-0 text-[12px] text-manila-label">
          Measured {day(m.measured_at) ?? ""}
          {m.settings?.thinking ? `, thinking ${m.settings.thinking}` : ""}
          {m.settings?.effort ? `, effort ${m.settings.effort}` : ""} · {m.file}
        </p>
      )}
    </article>
  );
}

// --- Side by side ---------------------------------------------------------------------------------

function SideCard({ side }: { side: PairSide }) {
  const s = side.score;
  const name = sideName(side);
  const sub = side.custom
    ? side.state === "not_run"
      ? null
      : `${side.model} with its own instructions`
    : side.maker
      ? `made by ${side.maker}`
      : null;
  return (
    <div className="rounded-[3px] border border-manila-label/40 bg-black/[0.04] px-4 py-3">
      <div className="font-display text-[19px] leading-tight font-semibold break-words">{name}</div>
      {sub && <div className="text-[12.5px] text-manila-label">{sub}</div>}
      {s ? (
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="font-display text-[30px] leading-none font-bold">{shownScore(s.overall)}</span>
          {s.margin_of_error !== null && <span className="font-display text-[16px] font-bold">± {shownScore(s.margin_of_error)}</span>}
          <span className="font-display text-[16px] font-bold" aria-label={`Grade ${s.grade}`}>
            · {s.grade}
          </span>
        </div>
      ) : (
        <div className="mt-1.5 font-label text-[13px] tracking-[0.12em] text-lie-ink uppercase">{stateHeadline({ state: side.state, waiting_for_judge: false }, null)}</div>
      )}
      {side.judge && <div className="mt-1 text-[12.5px]">Judge: {side.judge}</div>}
      {side.run_id && (
        <a href={hrefFor("report", { run: side.run_id })} className={`mt-1 inline-block text-[13px] ${LINK}`}>
          Report card →
        </a>
      )}
      {side.instructions && (
        <details className="mt-2 text-[13.5px]">
          <summary className="cursor-pointer font-label text-[12.5px] tracking-[0.08em] text-manila-label">Read its instructions</summary>
          <p className="mt-1.5 mb-0 rounded-[3px] bg-black/5 px-3 py-2 whitespace-pre-wrap">{side.instructions}</p>
        </details>
      )}
    </div>
  );
}

function TypeTable({ left, right }: { left: PairSide; right: PairSide }) {
  if (!left.score && !right.score) return null;
  const cell = (side: PairSide, key: string) => side.by_type[key]?.score ?? null;
  return (
    <table className="mt-4 w-full border-collapse text-[14px]">
      <caption className="sr-only">Score for each trap type, out of 100</caption>
      <thead>
        <tr className="border-b border-manila-label/45 text-left font-label text-[11.5px] tracking-[0.1em] text-manila-label">
          <th scope="col" className="py-1.5 pr-2 font-normal">TRAP TYPE</th>
          <th scope="col" className="py-1.5 pr-2 text-right font-normal">
            <span className="sr-only">{sideName(left)}</span>
            <span aria-hidden="true" className="break-words">{shortName(left)}</span>
          </th>
          <th scope="col" className="py-1.5 pr-2 text-right font-normal">
            <span className="sr-only">{sideName(right)}</span>
            <span aria-hidden="true" className="break-words">{shortName(right)}</span>
          </th>
          <th scope="col" className="py-1.5 text-right font-normal">GAP</th>
        </tr>
      </thead>
      <tbody>
        {TRAP_TYPES.map((t) => {
          const a = cell(left, t.key);
          const b = cell(right, t.key);
          const gap = a !== null && b !== null ? (shownScore(a) ?? 0) - (shownScore(b) ?? 0) : null;
          return (
            <tr key={t.key} className="border-b border-dashed border-manila-label/30 last:border-0">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                <span className="sm:hidden">{t.short}</span>
                <span className="hidden sm:inline">{t.label}</span>
              </th>
              <td className="py-1.5 pr-2 text-right font-display text-[16px] font-bold">{a === null ? "–" : shownScore(a)}</td>
              <td className="py-1.5 pr-2 text-right font-display text-[16px] font-bold">{b === null ? "–" : shownScore(b)}</td>
              <td className="py-1.5 text-right text-[13px]">{gap === null ? "" : gap === 0 ? "same" : gap > 0 ? `+${gap}` : `−${-gap}`}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={4} className="pt-1.5 text-[12px] text-manila-label">
            Gap: {sideName(left)}&rsquo;s score minus {sideName(right)}&rsquo;s.
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

/** A side's name, cut short for a table heading. */
function shortName(s: PairSide): string {
  const n = sideName(s);
  return n.length > 16 ? `${n.slice(0, 15)}…` : n;
}

function Differences({ pair }: { pair: LineupPair }) {
  const { left, right, differ } = pair;
  const l = sideName(left);
  const r = sideName(right);
  if (!differ) {
    const waiting = [left, right].filter((s) => s.state !== "scored");
    const text = waiting.length
      ? `This fills in once ${list(waiting.map((s) => s.model ?? "the other bot"))} ${waiting.length === 1 ? "has" : "have"} been run and judged.`
      : "These two were graded by different judges, so their verdicts aren't compared trap by trap.";
    return (
      <div className="mt-5 border-t border-dashed border-manila-label/45 pt-4">
        <Key>WHERE THEY DIFFER</Key>
        <p className="mt-1 mb-0 text-[14px]">{text}</p>
      </div>
    );
  }
  const groups = TRAP_TYPES.map((t) => ({ t, rows: differ.rows.filter((row) => row.type === t.key) })).filter((g) => g.rows.length);
  const firstOpen = groups[0]?.t.key;
  return (
    <div className="mt-5 border-t border-dashed border-manila-label/45 pt-4">
      <Key>WHERE THEY DIFFER</Key>
      <p className="mt-1 mb-0 text-[14.5px] leading-snug">
        {differ.rows.length === 0 ? (
          `The same verdict on all ${differ.compared} traps.`
        ) : (
          <>
            Different verdicts on <b>{differ.rows.length}</b> of {differ.compared} traps. {l} was caught on {differ.only_left_caught} where {r}{" "}
            wasn&rsquo;t, and {r} on {differ.only_right_caught} where {l} wasn&rsquo;t.
          </>
        )}
      </p>
      {groups.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {groups.map(({ t, rows }) => (
            <details key={t.key} open={t.key === firstOpen} className="rounded-[3px] border border-manila-label/35 bg-black/[0.03]">
              <summary className="cursor-pointer px-3 py-2 font-label text-[13px] tracking-[0.06em]">
                {t.label} · {rows.length}
              </summary>
              <ul className="m-0 list-none p-0">
                {rows.map((row) => (
                  <DiffItem key={row.trap} row={row} pair={pair} />
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffItem({ row, pair }: { row: DiffRow; pair: LineupPair }) {
  const l = sideName(pair.left);
  const r = sideName(pair.right);
  return (
    <li className="border-t border-dashed border-manila-label/30 px-3 py-2.5">
      <div className="text-[13.5px] leading-snug">
        <span className="mr-1.5 font-label text-[12px] text-manila-label">{row.trap}</span>
        <NameSafe text={row.question} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12.5px]">
        <span className="inline-flex items-center gap-2">
          <span className="text-manila-label">{l}:</span>
          {row.left ? <VerdictBadge verdict={row.left} size="sm" /> : <span>not judged</span>}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="text-manila-label">{r}:</span>
          {row.right ? <VerdictBadge verdict={row.right} size="sm" /> : <span>not judged</span>}
        </span>
        <span className="inline-flex gap-3">
          {pair.left.run_id && (
            <a href={hrefFor("evidence", { run: pair.left.run_id, trap: row.trap })} className={LINK}>
              {l}&rsquo;s answer
            </a>
          )}
          {pair.right.run_id && (
            <a href={hrefFor("evidence", { run: pair.right.run_id, trap: row.trap })} className={LINK}>
              {r}&rsquo;s answer
            </a>
          )}
        </span>
      </div>
    </li>
  );
}

export function SideBySide({ pair }: { pair: LineupPair }) {
  const title = `${sideName(pair.left)} vs ${sideName(pair.right)}`;
  return (
    <article className="manila max-w-[1220px] rounded-[3px] px-5 py-6 sm:px-7" aria-labelledby={`pair-${pair.id}`}>
      <Key>SIDE BY SIDE{pair.kind === "custom" ? " · NOT RANKED" : ""}</Key>
      <h3 id={`pair-${pair.id}`} className="mt-1 mb-0 font-display text-[23px] leading-tight font-semibold break-words">
        {title}
      </h3>
      {pair.why && <p className="mt-1.5 mb-0 max-w-[820px] text-[14.5px] leading-relaxed">{pair.why}</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SideCard side={pair.left} />
        <SideCard side={pair.right} />
      </div>
      <TypeTable left={pair.left} right={pair.right} />
      <Differences pair={pair} />
    </article>
  );
}
