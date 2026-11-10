// The lineup (Session 9): every bot in src/data/lineup.json on one height-chart
// wall, the judges behind the scores, and the side-by-sides. Built by
// export-runs.mjs from the judged runs; nothing here reads files, so tests can
// feed it made-up runs.
//
// A bot's state on the wall:
//   scored      judged by a judge whose grades stand: its Truth Score is shown
//   on_hold     judged, but only by a judge whose grades are on hold: no score
//   not_judged  run, but not judged yet: no score
//   not_run     not interrogated yet

const CAUGHT = ["LIE", "CAVED", "CONTRADICTED"];
const TYPE_ORDER = [
  "ghost_fact",
  "false_premise",
  "fake_citation",
  "pressure_test",
  "consistency",
  "know_your_limits",
  "number_trap",
  "stick_to_document",
];

/** How many of a run's answers hit the length limit (they're judged and scored as they stand). */
export function cutOffs(run) {
  const traps = new Set();
  let answers = 0;
  for (const t of run?.traps ?? []) {
    for (const c of t.conversations ?? []) {
      for (const turn of c.turns ?? []) {
        if (turn.role === "assistant" && turn.call?.truncated) {
          answers += 1;
          traps.add(t.id);
        }
      }
    }
  }
  return { answers, traps: [...traps].sort() };
}

/** A run that covers the whole lineup trap set: the right fingerprint, every trap in it. */
function complete(entry, roster) {
  if (entry.trap_set !== roster.trap_set) return false;
  return entry.traps_in_library == null || entry.traps === entry.traps_in_library;
}

const newestFirst = (a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0);

/** The judge's numbers a placard shows: its agreement with Christian, and which way it leans. */
function placardJudge(entry) {
  const jc = entry.judge_check;
  return {
    model: entry.judge,
    company: entry.judge_company ?? null,
    measured: jc
      ? {
          agree: jc.agree,
          answers: jc.answers,
          percent: jc.percent,
          honest_called_caught: jc.honest_called_caught,
          caught_called_honest: jc.caught_called_honest,
          direction: jc.lean?.direction ?? null,
        }
      : null,
  };
}

const sizeOf = (details) => details?.parameter_size ?? null;

/**
 * The bots on the wall, in the roster's order (the screen sorts them).
 * `entries` are the dashboard's index entries (judged runs), `runs` maps an
 * entry's id to its trimmed run, and `originals` describes the run files in
 * runs/ that aren't judged copies.
 */
export function lineupBots({ roster, entries, runs, originals }) {
  const held = new Set(roster.judge_hold?.judges ?? []);
  const waiting = new Set(roster.judge_hold?.bots ?? []);
  return roster.bots.map((bot) => {
    const judged = entries.filter((e) => e.model === bot.model && !e.custom && complete(e, roster)).sort(newestFirst);
    const standing = judged.find((e) => !held.has(e.judge));
    const onHold = judged.find((e) => held.has(e.judge));
    const ran = originals.filter((o) => o.model === bot.model && !o.custom && complete(o, roster)).sort(newestFirst)[0];
    const base = {
      model: bot.model,
      maker: bot.maker ?? null,
      provider: bot.provider ?? null,
      waiting_for_judge: waiting.has(bot.model),
    };
    if (standing) {
      const run = runs.get(standing.id);
      return {
        ...base,
        state: "scored",
        size: sizeOf(run?.run?.target?.model_details),
        run_id: standing.id,
        started_at: standing.started_at,
        traps: standing.traps,
        score: {
          overall: standing.overall,
          grade: standing.grade,
          margin_of_error: standing.margin_of_error,
          interval: standing.interval ?? null,
        },
        judge: placardJudge(standing),
        held_by: null,
        thinking: standing.thinking ?? null,
        cut_off: cutOffs(run),
      };
    }
    if (onHold) {
      const run = runs.get(onHold.id);
      // No score, and no judge's numbers: they're the grades on hold.
      return {
        ...base,
        state: "on_hold",
        size: sizeOf(run?.run?.target?.model_details),
        run_id: onHold.id,
        started_at: onHold.started_at,
        traps: onHold.traps,
        score: null,
        judge: null,
        held_by: onHold.judge,
        thinking: onHold.thinking ?? null,
        cut_off: cutOffs(run),
      };
    }
    if (ran) {
      return {
        ...base,
        state: "not_judged",
        size: ran.size ?? null,
        run_id: null,
        started_at: ran.started_at,
        traps: ran.traps,
        score: null,
        judge: null,
        held_by: null,
        thinking: ran.thinking ?? null,
        cut_off: ran.cut_off ?? null,
      };
    }
    return {
      ...base,
      state: "not_run",
      size: null,
      run_id: null,
      started_at: null,
      traps: null,
      score: null,
      judge: null,
      held_by: null,
      thinking: null,
      cut_off: null,
    };
  });
}

/** Every trap where the two runs' verdicts differ, in trap-type order. */
export function verdictDifferences(left, right) {
  const theirs = new Map((right?.traps ?? []).map((t) => [t.id, t]));
  const rows = [];
  let compared = 0;
  for (const t of left?.traps ?? []) {
    const other = theirs.get(t.id);
    if (!other) continue;
    compared += 1;
    if ((t.verdict ?? null) === (other.verdict ?? null)) continue;
    const question = String(t.trap?.question ?? "");
    rows.push({
      trap: t.id,
      type: t.type,
      question: question.length > 170 ? `${question.slice(0, 167).trimEnd()}…` : question,
      left: t.verdict ?? null,
      right: other.verdict ?? null,
    });
  }
  const at = (type) => {
    const i = TYPE_ORDER.indexOf(type);
    return i < 0 ? TYPE_ORDER.length : i;
  };
  rows.sort((a, b) => at(a.type) - at(b.type) || (a.trap < b.trap ? -1 : a.trap > b.trap ? 1 : 0));
  const tally = (pick) => rows.filter(pick).length;
  return {
    compared,
    rows,
    // Which way the differences go: answers one side got caught on and the other didn't.
    only_left_caught: tally((r) => CAUGHT.includes(r.left) && !CAUGHT.includes(r.right)),
    only_right_caught: tally((r) => CAUGHT.includes(r.right) && !CAUGHT.includes(r.left)),
  };
}

function side(bot, entry, run, custom = false) {
  if (entry) {
    return {
      model: entry.model,
      name: entry.name ?? null,
      custom: !!entry.custom,
      maker: entry.maker ?? bot?.maker ?? null,
      state: "scored",
      run_id: entry.id,
      score: { overall: entry.overall, grade: entry.grade, margin_of_error: entry.margin_of_error, interval: entry.interval ?? null },
      by_type: entry.by_type ?? {},
      judge: entry.judge,
      instructions: run?.run?.target?.system_prompt?.trim() || null,
    };
  }
  return {
    model: bot?.model ?? null,
    name: null,
    custom,
    maker: bot?.maker ?? null,
    // A lineup bot keeps its own state (judge being chosen, not run...); a missing custom bot isn't run yet.
    state: custom ? "not_run" : bot?.state ?? "not_run",
    run_id: null,
    score: null,
    by_type: {},
    judge: null,
    instructions: null,
  };
}

/**
 * The side-by-sides. A "custom" pair is a bot with its own instructions next to
 * the plain model it runs on (the custom bot is never on the wall); a "models"
 * pair is two lineup bots. Verdicts are compared trap by trap only when both
 * sides are scored by the same judge.
 */
export function lineupPairs({ roster, entries, runs, bots }) {
  const held = new Set(roster.judge_hold?.judges ?? []);
  const scoredEntry = (model) => {
    const b = bots.find((x) => x.model === model);
    return b?.state === "scored" ? entries.find((e) => e.id === b.run_id) : undefined;
  };
  return (roster.pairs ?? []).map((pair) => {
    let left;
    let right;
    let leftBot;
    let rightBot;
    const custom = pair.kind === "custom";
    if (custom) {
      left = entries
        .filter((e) => e.model === pair.model && e.custom && complete(e, roster) && !held.has(e.judge))
        .sort(newestFirst)[0];
      rightBot = bots.find((x) => x.model === pair.model) ?? { model: pair.model, state: "not_run" };
      leftBot = { model: pair.model, maker: rightBot.maker ?? null };
      right = scoredEntry(pair.model);
    } else {
      leftBot = bots.find((x) => x.model === pair.left) ?? { model: pair.left, state: "not_run" };
      rightBot = bots.find((x) => x.model === pair.right) ?? { model: pair.right, state: "not_run" };
      left = scoredEntry(pair.left);
      right = scoredEntry(pair.right);
    }
    const sameJudge = left && right && left.judge === right.judge;
    return {
      id: pair.id,
      kind: pair.kind,
      why: pair.why ?? null,
      left: side(leftBot, left, left && runs.get(left.id), custom),
      right: side(rightBot, right, right && runs.get(right.id)),
      same_judge: !!sameJudge,
      differ: sameJudge ? verdictDifferences(runs.get(left.id), runs.get(right.id)) : null,
    };
  });
}

/**
 * The judges panel: every judge measured on Christian's test half (the same
 * three numbers for each, his rule), plus any judge grading the lineup that
 * hasn't been measured. `records` are docs/judge-check/final*.json, each with
 * its `decision` (a judge that missed the line set in advance) already looked up.
 */
export function lineupJudges({ roster, records, bots, entries, leanOf }) {
  const hold = roster.judge_hold ?? null;
  const held = new Set(hold?.judges ?? []);
  const company = (judge) => entries.find((e) => e.judge === judge)?.judge_company ?? null;
  const out = records.map((f) => ({
    judge: f.judge,
    company: company(f.judge),
    grades: bots.filter((b) => b.state === "scored" && b.judge?.model === f.judge).map((b) => b.model),
    held_bots: bots.filter((b) => b.state === "on_hold" && b.held_by === f.judge).map((b) => b.model),
    measured: {
      answers: f.answers,
      agree: f.agree,
      percent: f.percent,
      percent_range: f.percent_range ?? null,
      kappa: f.kappa ?? null,
      honest_vs_caught: f.same_points ?? null,
      score_of_the_50: { labels: f.your_points ?? null, judge: f.polygraph_points ?? null },
      lean: leanOf(f.confusion),
      measured_at: f.measured_at ?? null,
      file: `docs/judge-check/${f.file}`,
      settings: f.judge_settings ? { thinking: f.judge_settings.thinking ?? null } : null,
    },
    line: f.decision
      ? { agree: f.decision.line?.agree ?? null, answers: f.decision.line?.answers ?? null, percent: f.decision.line?.percent ?? null, passed: !!f.decision.passed }
      : null,
    decision: f.decision ? { decision: f.decision.decision ?? null, why: f.decision.why ?? [], file: f.decision.file ?? null } : null,
    hold: held.has(f.judge) ? { since: hold.since ?? null, why: hold.why ?? null } : null,
    versus: f.versus_first_judge
      ? {
          other: f.versus_first_judge.first_judge,
          agree: f.versus_first_judge.all?.agree ?? null,
          answers: f.versus_first_judge.all?.answers ?? null,
          percent: f.versus_first_judge.all?.percent ?? null,
        }
      : null,
  }));
  // A judge grading the lineup that was never checked against Christian's labels.
  for (const b of bots) {
    const judge = b.state === "scored" ? b.judge?.model : b.state === "on_hold" ? b.held_by : null;
    if (!judge || out.some((j) => j.judge === judge)) continue;
    out.push({
      judge,
      company: company(judge),
      grades: bots.filter((x) => x.state === "scored" && x.judge?.model === judge).map((x) => x.model),
      held_bots: bots.filter((x) => x.state === "on_hold" && x.held_by === judge).map((x) => x.model),
      measured: null,
      line: null,
      decision: null,
      hold: held.has(judge) ? { since: hold?.since ?? null, why: hold?.why ?? null } : null,
      versus: null,
    });
  }
  return out;
}

/** Everything the lineup screen shows. */
export function buildLineup({ roster, entries, runs, originals, records, leanOf }) {
  if (!roster) return null;
  const bots = lineupBots({ roster, entries, runs, originals });
  // The judges in the order they were measured: gpt-6-luna (Session 5) first.
  records = [...records].sort((a, b) => String(a.measured_at ?? "").localeCompare(String(b.measured_at ?? "")));
  return {
    trap_set: roster.trap_set,
    traps: Math.max(0, ...bots.map((b) => b.traps ?? 0)) || null,
    hold: roster.judge_hold
      ? { judges: roster.judge_hold.judges ?? [], bots: roster.judge_hold.bots ?? [], since: roster.judge_hold.since ?? null, headline: roster.judge_hold.headline ?? null, why: roster.judge_hold.why ?? null }
      : null,
    bots,
    judges: lineupJudges({ roster, records, bots, entries, leanOf }),
    pairs: lineupPairs({ roster, entries, runs, bots }),
  };
}
