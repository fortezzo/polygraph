import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, SERVER_DOWN, getSetup, makePlan, startRun, usd, type BotOption, type Choices, type Plan, type Problem, type Setup } from "../lib/api";
import { hrefFor } from "../lib/route";
import { StatePanel } from "../components/States";
import { TopBar } from "../components/TopBar";

// The New interrogation screen (Session 8): pick the bot, the judge and the trap
// types, see what it will cost, confirm, then watch it live.

type Loaded<T> = { status: "loading" } | { status: "problem"; problem: Problem } | { status: "ready"; data: T };

const keyOf = (o: { provider: string; model: string }) => `${o.provider}|${o.model}`;
const split = (key: string) => {
  const [provider, ...rest] = key.split("|");
  return { provider: provider ?? "", model: rest.join("|") };
};

const Key = ({ children }: { children: ReactNode }) => (
  <div className="mb-1 font-label text-[11.5px] tracking-[0.18em] text-manila-label">{children}</div>
);

const field = "w-full rounded-[3px] border border-manila-label/50 bg-[#f4e7c6] px-3 py-2.5 font-type text-[15px] text-manila-ink focus:border-manila-ink";

function ProblemBox({ problem }: { problem: Problem }) {
  return (
    <div role="alert" className="rounded-[3px] border-2 border-lie-ink/70 bg-lie-ink/[0.06] px-3.5 py-2.5 text-[14px] leading-snug">
      <div className="font-label text-[12px] tracking-[0.14em] text-lie-ink">{problem.title.toUpperCase()}</div>
      <p className="mt-1 mb-0">{problem.message}</p>
      {problem.hint && <p className="mt-1 mb-0 text-manila-label">{problem.hint}</p>}
    </div>
  );
}

function botLabel(b: BotOption): string {
  const bits = [b.model, b.maker ? `made by ${b.maker}` : null, b.local ? b.size ?? null : `$${b.price_in} in / $${b.price_out} out per million tokens`];
  return bits.filter(Boolean).join(" · ") + (b.available ? "" : ` (${b.why_not?.toLowerCase()})`);
}

export function NewRunScreen() {
  const [setup, setSetup] = useState<Loaded<Setup>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setSetup({ status: "loading" });
    getSetup().then(
      (data) => live && setSetup({ status: "ready", data }),
      (e: unknown) => live && setSetup({ status: "problem", problem: e instanceof ApiError ? e.problem : SERVER_DOWN }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-4 pt-3 pb-12 sm:px-6 lg:px-8 lg:pt-[18px]">
      <TopBar active="new" />
      <main id="content" data-ready={setup.status === "ready" ? "" : undefined}>
        {setup.status === "loading" && <StatePanel kicker="LOADING" title="Asking Polygraph's server what it can run…" live="polite" />}
        {setup.status === "problem" && (
          <StatePanel kicker="SOMETHING WENT WRONG" title={setup.problem.title} live="assertive" onRetry={() => setAttempt((n) => n + 1)}>
            <p className="m-0">{setup.problem.message}</p>
            {setup.problem.hint && <p className="mt-2 mb-0">{setup.problem.hint}</p>}
            <p className="mt-2 mb-0 text-muted">The recorded runs still work: try the report card or the interrogation room.</p>
          </StatePanel>
        )}
        {setup.status === "ready" && <IntakeForm setup={setup.data} />}
      </main>
    </div>
  );
}

function IntakeForm({ setup }: { setup: Setup }) {
  const firstBot = setup.bots.find((b) => b.available && b.local) ?? setup.bots.find((b) => b.available);
  const [bot, setBot] = useState(firstBot ? keyOf(firstBot) : "");
  const [judge, setJudge] = useState("");
  const [types, setTypes] = useState<string[]>(setup.trap_types.map((t) => t.type));
  const [own, setOwn] = useState(false);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [freshChoice, setFreshChoice] = useState<boolean | null>(null);
  const [allowMore, setAllowMore] = useState(false);
  const [plan, setPlan] = useState<Loaded<Plan> | null>(null);
  const [starting, setStarting] = useState(false);
  const [startProblem, setStartProblem] = useState<Problem | null>(null);

  const chosen = setup.bots.find((b) => keyOf(b) === bot);
  const fresh = freshChoice ?? (chosen?.local ?? true);
  const ownReady = !own || (name.trim().length > 0 && instructions.trim().length > 0);
  const running = setup.run && setup.run.state !== "done" ? setup.run : null;

  const choices: Choices | null = useMemo(() => {
    if (!chosen) return null;
    const j = judge ? split(judge) : null;
    return {
      bot_provider: chosen.provider,
      bot_model: chosen.model,
      judge_provider: j?.provider ?? null,
      judge_model: j?.model ?? null,
      types,
      fresh,
      own_bot: own && ownReady ? { name: name.trim(), instructions: instructions.trim() } : null,
      max_cost: setup.limit_usd,
    };
  }, [chosen, judge, types, fresh, own, ownReady, name, instructions, setup.limit_usd]);

  // Work out the plan and its cost whenever a choice changes (after a short pause while typing).
  useEffect(() => {
    if (!choices || types.length === 0) {
      setPlan(null);
      return;
    }
    let live = true;
    setPlan((p) => (p && p.status === "ready" ? p : { status: "loading" }));
    const timer = window.setTimeout(() => {
      makePlan(choices).then(
        (data) => live && setPlan({ status: "ready", data }),
        (e: unknown) => live && setPlan({ status: "problem", problem: e instanceof ApiError ? e.problem : SERVER_DOWN }),
      );
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [choices, types.length]);

  const ready = plan?.status === "ready" ? plan.data : null;
  const overLimit = !!ready && ready.over_limit;
  const canStart = !!ready && !!choices && ownReady && types.length > 0 && (!overLimit || allowMore) && !starting && !running;

  const start = () => {
    if (!choices || !ready) return;
    setStarting(true);
    setStartProblem(null);
    startRun({ ...choices, max_cost: overLimit && allowMore ? ready.suggested_limit_usd : setup.limit_usd }).then(
      () => {
        // "from=start": watch it from the first question, even if the server is quicker.
        window.location.hash = hrefFor("live", { from: "start" });
      },
      (e: unknown) => {
        setStarting(false);
        setStartProblem(e instanceof ApiError ? e.problem : SERVER_DOWN);
      },
    );
  };

  const local = setup.bots.filter((b) => b.local);
  const cloud = ["openai", "anthropic", "google"].map((p) => ({ provider: p, bots: setup.bots.filter((b) => !b.local && b.provider === p) }));
  const judges = setup.judges.filter((j) => j.available && j.maker !== chosen?.maker);

  return (
    <div className="mx-auto max-w-[1220px]">
      <div className="mb-5">
        <h1 className="m-0 font-display text-[28px] font-semibold tracking-[0.08em] text-[#f3e8d2] sm:text-[34px]">NEW INTERROGATION</h1>
        <p className="mt-1 mb-0 max-w-[720px] text-[15px] text-soft">
          Pick a bot and the traps, check the cost, then watch it live. Everything is saved to the runs folder, judged the same way as every other run.
        </p>
      </div>
      {running && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-[4px] border border-brass/50 bg-brass/10 px-4 py-3 text-[15px] text-soft" role="status">
          <span>
            An interrogation is going: <b className="text-text">{running.name ?? running.model}</b>. Polygraph runs one at a time.
          </span>
          <a href={hrefFor("live")} className="inline-flex h-11 items-center rounded-[3px] bg-brass px-4 font-label text-[14px] text-room no-underline">
            Watch it live →
          </a>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start">
        {/* The intake form */}
        <form className="manila rounded-[4px] px-5 py-5 sm:px-7 sm:py-6" onSubmit={(e) => e.preventDefault()} aria-label="New interrogation">
          <fieldset className="m-0 border-0 p-0">
            <legend className="p-0">
              <Key>1 · THE SUBJECT</Key>
            </legend>
            <label htmlFor="bot" className="sr-only">Which bot to interrogate</label>
            <select id="bot" className={field} value={bot} onChange={(e) => setBot(e.target.value)} aria-describedby="bot-help">
              {local.length > 0 && (
                <optgroup label="On this PC (free)">
                  {local.map((b) => (
                    <option key={keyOf(b)} value={keyOf(b)}>{botLabel(b)}</option>
                  ))}
                </optgroup>
              )}
              {cloud.map((g) =>
                g.bots.length ? (
                  <optgroup key={g.provider} label={g.bots[0]!.provider_label ?? g.provider}>
                    {g.bots.map((b) => (
                      <option key={keyOf(b)} value={keyOf(b)} disabled={!b.available}>{botLabel(b)}</option>
                    ))}
                  </optgroup>
                ) : null,
              )}
            </select>
            <p id="bot-help" className="mt-1.5 mb-0 text-[13px] leading-snug text-manila-label">
              {chosen?.local ? "It runs on this PC, so it's free." : chosen ? "A cloud model: it costs money, and the cost guard keeps it under the limit." : ""}{" "}
              Cloud models need their company&rsquo;s API key in .env.
            </p>
            {!setup.ollama.ok && setup.ollama.problem && (
              <div className="mt-2.5">
                <ProblemBox problem={setup.ollama.problem} />
              </div>
            )}

            <div className="mt-4 rounded-[3px] border border-dashed border-manila-label/50 px-3.5 py-3">
              <label className="flex cursor-pointer items-start gap-2.5 text-[15px]">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[#2a2015]" checked={own} onChange={(e) => setOwn(e.target.checked)} />
                <span>
                  <b>Test your own bot.</b> Give it instructions (a system prompt) and a name. It runs on the model above.
                </span>
              </label>
              {own && (
                <div className="mt-3 flex flex-col gap-3">
                  <div>
                    <label htmlFor="own-name" className="mb-1 block text-[14px] font-bold">Its name</label>
                    <input id="own-name" className={field} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Bob's Pizza bot" aria-describedby={!name.trim() ? "own-name-need" : undefined} />
                    {!name.trim() && <p id="own-name-need" className="mt-1 mb-0 text-[13px] text-manila-label">Needed: what to call it on the report card.</p>}
                  </div>
                  <div>
                    <label htmlFor="own-instructions" className="mb-1 block text-[14px] font-bold">Its instructions</label>
                    <textarea
                      id="own-instructions"
                      className={`${field} min-h-[150px] leading-relaxed`}
                      maxLength={20000}
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      placeholder="You are the support bot for Bob's Pizza. We're open 11am to 10pm, every day. We deliver within 3 miles."
                      aria-describedby="own-help"
                    />
                    <p id="own-help" className="mt-1 mb-0 text-[13px] leading-snug text-manila-label">
                      Sent before every conversation. The judge sees them too, as background, so the bot isn&rsquo;t called a liar for repeating facts you gave it. {instructions.length > 0 && `${instructions.length.toLocaleString("en-US")} of 20,000 characters.`}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </fieldset>

          <fieldset className="mt-6 m-0 border-0 p-0">
            <legend className="p-0">
              <Key>2 · THE JUDGE</Key>
            </legend>
            <label htmlFor="judge" className="sr-only">Which model judges the answers</label>
            <select id="judge" className={field} value={judge} onChange={(e) => setJudge(e.target.value)} aria-describedby="judge-help">
              <option value="">Polygraph&rsquo;s pick{ready && !judge ? `: ${ready.judge.model} (${ready.judge.maker})` : ""}</option>
              {judges.map((j) => (
                <option key={keyOf(j)} value={keyOf(j)}>
                  {j.model} · made by {j.maker} · ${j.price_in} in / ${j.price_out} out per million tokens
                </option>
              ))}
            </select>
            <p id="judge-help" className="mt-1.5 mb-0 text-[13px] leading-snug text-manila-label">
              Always from a different company than the bot, voting {setup.votes} times on every trap. Polygraph&rsquo;s pick is the one checked against Christian&rsquo;s hand labels.
            </p>
          </fieldset>

          <fieldset className="mt-6 m-0 border-0 p-0">
            <legend className="p-0">
              <Key>3 · THE TRAPS</Key>
            </legend>
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {setup.trap_types.map((t) => (
                <label key={t.type} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[15px] sm:min-h-9">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#2a2015]"
                    checked={types.includes(t.type)}
                    onChange={(e) => setTypes((cur) => (e.target.checked ? setup.trap_types.map((x) => x.type).filter((x) => x === t.type || cur.includes(x)) : cur.filter((x) => x !== t.type)))}
                  />
                  <span>
                    {t.label} <span className="text-manila-label">({t.count})</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[14px]">
              <button type="button" className="h-11 rounded-[3px] border border-manila-ink/50 px-3 font-label text-[13px] sm:h-9" onClick={() => setTypes(setup.trap_types.map((t) => t.type))}>
                All 8
              </button>
              <button type="button" className="h-11 rounded-[3px] border border-manila-ink/50 px-3 font-label text-[13px] sm:h-9" onClick={() => setTypes([])}>
                None
              </button>
              <span className="text-manila-label">{types.length === 0 ? "Pick at least one." : "Fewer types make a quicker run."}</span>
            </div>
          </fieldset>

          <fieldset className="mt-6 m-0 border-0 p-0">
            <legend className="p-0">
              <Key>4 · THE ANSWERS</Key>
            </legend>
            <label className="flex cursor-pointer items-start gap-2.5 text-[15px]">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[#2a2015]" checked={fresh} onChange={(e) => setFreshChoice(e.target.checked)} />
              <span>
                <b>Ask every question again.</b>{" "}
                {fresh
                  ? "You'll watch the bot write every answer."
                  : "Answers saved from earlier runs are reused (free), and the live screen marks each one as a saved answer."}
              </span>
            </label>
            {ready && !fresh && <p className="mt-1.5 mb-0 pl-6.5 text-[13px] text-manila-label">{ready.saved} of {ready.questions} replies are saved from earlier runs.</p>}
          </fieldset>
        </form>

        {/* The plan */}
        <aside className="card-paper on-paper relative rounded-[4px] px-5 pt-6 pb-5 sm:px-6 lg:sticky lg:top-4" aria-label="The plan and its cost" aria-live="polite">
          <Key>THE PLAN</Key>
          {/* The plan's room is kept while it's worked out, so Start doesn't move when it arrives. */}
          <div className="lg:min-h-[290px]">
            {types.length === 0 ? (
              <p className="m-0 text-[15px]">Pick at least one trap type.</p>
            ) : !plan || plan.status === "loading" ? (
              <p className="m-0 text-[15px] text-manila-label">Working out the plan…</p>
            ) : plan.status === "problem" ? (
              <ProblemBox problem={plan.problem} />
            ) : (
              <PlanCard plan={plan.data} limit={setup.limit_usd} />
            )}
          </div>
          {ready && overLimit && (
            <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-[3px] border-2 border-caved-ink/60 px-3 py-2.5 text-[14px]">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#2a2015]" checked={allowMore} onChange={(e) => setAllowMore(e.target.checked)} />
              <span>
                This should cost about {usd(ready.typical_usd)}, more than the {usd(setup.limit_usd)} limit. <b>Allow up to {usd(ready.suggested_limit_usd)} for this run.</b>
              </span>
            </label>
          )}
          {startProblem && (
            <div className="mt-3">
              <ProblemBox problem={startProblem} />
            </div>
          )}
          <button
            type="button"
            onClick={start}
            disabled={!canStart}
            className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[3px] bg-manila-ink px-4 font-label text-[16px] tracking-[0.06em] text-[#f3e8d2] hover:bg-black disabled:cursor-not-allowed disabled:opacity-45"
          >
            {starting ? "Starting…" : "Start the interrogation"}
          </button>
          <p className="mt-2 mb-0 text-[12.5px] leading-snug text-manila-label">
            {own && !ownReady ? "Give your bot a name and its instructions first. " : ""}
            You can stop it at any time; what&rsquo;s finished is saved and judged.
          </p>
        </aside>
      </div>
    </div>
  );
}

function PlanCard({ plan, limit }: { plan: Plan; limit: number }) {
  const rows: [string, ReactNode][] = [
    [
      "Subject",
      <>
        <b>{plan.bot.name ?? plan.bot.model}</b>
        {plan.bot.name ? ` (built on ${plan.bot.model})` : ""}, made by {plan.bot.maker}, run with {plan.bot.local ? `${plan.bot.provider_label} on this PC` : plan.bot.provider_label}
      </>,
    ],
    ["Judge", <>{plan.judge.model}, made by {plan.judge.maker}, {plan.judge.votes} votes per trap</>],
    ["Traps", <>{plan.traps}, one at a time</>],
    [
      "Questions",
      <>
        {plan.questions} to the bot (answers and how-sure checks){plan.saved > 0 && !plan.fresh ? `, ${plan.saved} already saved` : ""}; about {plan.judge_questions} to the judge
      </>,
    ],
    [
      "Cost",
      plan.free ? (
        <>
          <b>Free.</b> Nothing in this run costs money.
        </>
      ) : (
        <>
          <b>about {usd(plan.typical_usd)}</b>
          <span className="text-manila-label">
            {" "}
            (the bot: {plan.bot.local ? "free on this PC" : `about ${usd(plan.bot_usd)}`}; the judge: about {usd(plan.judge_usd)}, less for verdicts it has given before)
          </span>
        </>
      ),
    ],
    ["Limit", <>{usd(limit)}. Polygraph stops before it could go over.</>],
  ];
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[14.5px] leading-snug">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-label text-[12px] tracking-[0.12em] text-manila-label">{k.toUpperCase()}</dt>
          <dd className="m-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
