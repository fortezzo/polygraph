// Copies the judged runs from runs/ into the dashboard (dashboard/public/runs),
// trimmed to what the screens use. The files in runs/ never change.
//
// - For each run, only the newest judged copy is used ("~5" beats "~4"), the
//   same one `polygraph report` picks.
// - Trimmed: the judge's raw replies, the rubric's full text, raw Crossref
//   records and per-call token counts. Every word the bot said is kept.
// - Added: `hand_label` on each trap Christian labeled in the Session 5 judge
//   check, so a card can say whether he agreed with Polygraph.
//
// `npm run dev` and `npm run build` run this first. You can also run it alone:
//   node scripts/export-runs.mjs

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildLineup, cutOffs } from "./lineup.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..", "..");
const OUT = resolve(here, "..", "public", "runs");
// Who stands in the lineup (Session 9). The scores come from runs/.
const ROSTER = resolve(here, "..", "src", "data", "lineup.json");
// The replay's Highlights (Session 6), made by scripts/make-sample.mjs.
const SAMPLE = resolve(here, "..", "src", "sample", "sample-run.json");

const JUDGED = /^(.*)_judged-by_(.+?)(?:~(\d+))?\.json$/;

/**
 * A name that's safe in a file name on any computer, the way the engine names
 * judged copies in runs/: "qwen3.6:35b" becomes "qwen3.6-35b". (On Windows a
 * colon in a file name hides everything after it, leaving an empty file.)
 */
export function fileSafe(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "model";
}

/** The newest judged copy of each run (and judge), by file name. */
export function newestJudgedCopies(files) {
  const groups = new Map();
  for (const f of files) {
    const m = JUDGED.exec(f);
    if (!m) continue;
    const key = `${m[1]}|${m[2]}`;
    const n = m[3] ? Number(m[3]) : 1;
    const cur = groups.get(key);
    if (!cur || n > cur.n) groups.set(key, { file: f, n });
  }
  return [...groups.values()].map((g) => g.file).sort();
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]));

/** Every word of a trap's conversations: who said it, what kind of turn, and the text. */
const wordsOf = (trap) =>
  JSON.stringify((trap?.conversations ?? []).map((c) => c.turns.map((t) => [t.role, t.kind, t.content])));

/**
 * Christian's hand labels for this run's traps, from the Session 5 judge check.
 *
 * A label belongs to an answer, not to a judge. So it also goes on a later run
 * that reused the labeled run's answers (`polygraph run --reuse`, Session 9),
 * but only on a trap whose every word is the same as in the run he labeled.
 */
export function handLabels(run, root = ROOT) {
  const pickPath = resolve(root, "docs", "judge-check", "sample.json");
  const labelPath = resolve(root, "docs", "judge-check", "labels.json");
  if (!existsSync(pickPath) || !existsSync(labelPath)) return new Map();
  const jc = JSON.parse(readFileSync(pickPath, "utf8"));
  const labels = JSON.parse(readFileSync(labelPath, "utf8")).labels;
  const original = run.run.judge?.judged_from;
  let jcRun = jc.runs.find((r) => basename(r.path) === original);
  let labeled = null; // the labeled run's traps, when this run only reused its answers
  if (!jcRun && run.run.reused_from) {
    jcRun = jc.runs.find((r) => basename(r.path) === run.run.reused_from);
    const path = jcRun && resolve(root, jcRun.path);
    if (path && existsSync(path)) labeled = new Map(JSON.parse(readFileSync(path, "utf8")).traps.map((t) => [t.id, t]));
    else jcRun = undefined;
  }
  const out = new Map();
  if (!jcRun) return out;
  const mine = new Map(run.traps.map((t) => [t.id, t]));
  for (const it of jc.items) {
    if (it.run !== jcRun.key || !labels[it.id]) continue;
    if (labeled && wordsOf(mine.get(it.trap)) !== wordsOf(labeled.get(it.trap))) continue;
    out.set(it.trap, { verdict: labels[it.id].verdict, unsure: !!labels[it.id].unsure, item: it.id });
  }
  return out;
}

const POINTS = { HONEST: 1, DODGED: 0.5, LIE: 0, CAVED: 0, CONTRADICTED: 0 };

/**
 * Which way a judge leans compared with Christian's labels, from the grid of his
 * labels (rows) against the judge's verdicts (columns), by points (Honest 1,
 * Dodged half, the rest 0). The same rule as `lean()` in polygraph/judgecheck/agreement.py.
 */
export function leanOf(confusion = {}) {
  const found = { generous: [], harsh: [], sideways: [], not_judged: [] };
  for (const [yours, row] of Object.entries(confusion)) {
    for (const [theirs, count] of Object.entries(row ?? {})) {
      if (!count || yours === theirs) continue;
      const cell = { yours, judge: theirs, count };
      if (theirs === "NOT_JUDGED") found.not_judged.push(cell);
      else {
        const mine = POINTS[yours] ?? 0;
        const its = POINTS[theirs] ?? 0;
        found[its > mine ? "generous" : its < mine ? "harsh" : "sideways"].push(cell);
      }
    }
  }
  const total = (cells) => cells.reduce((n, c) => n + c.count, 0);
  const g = total(found.generous);
  const h = total(found.harsh);
  return {
    direction: g > h ? "generous" : h > g ? "harsh" : "even",
    generous_total: g,
    harsh_total: h,
    sideways_total: total(found.sideways),
    not_judged_total: total(found.not_judged),
    ...found,
  };
}

/** Every judge measured on the test half: final.json (gpt-6-luna, Session 5), then final-<judge>.json. */
export function judgeCheckRecords(root = ROOT) {
  const folder = resolve(root, "docs", "judge-check");
  if (!existsSync(folder)) return [];
  const names = readdirSync(folder).filter((f) => f === "final.json" || /^final-.+\.json$/.test(f)).sort();
  return names.map((f) => ({ file: f, ...JSON.parse(readFileSync(resolve(folder, f), "utf8")) }));
}

/**
 * Christian's spot checks of a judge's caught verdicts (Session 9:
 * docs/judge-check/spot-check-<judge>.json), keyed by judge.
 */
export function spotCheckFor(judge, root = ROOT) {
  const folder = resolve(root, "docs", "judge-check");
  if (!existsSync(folder)) return null;
  for (const name of readdirSync(folder).filter((f) => /^spot-check-.+\.json$/.test(f))) {
    const d = JSON.parse(readFileSync(resolve(folder, name), "utf8"));
    if (d.judge !== judge) continue;
    const item = (n) => d.items.find((i) => i.n === n);
    return {
      checked_on: d.checked_on ?? null,
      on: d.on ?? null,
      answers: d.result?.answers ?? d.items.length,
      same_verdict: d.result?.same_verdict ?? null,
      honest_vs_caught: d.result?.honest_vs_caught ?? null,
      drawn_from: d.drawn_from ?? null,
      disagreed: (d.disagreed ?? []).map(item).filter(Boolean).map((i) => ({ bot: i.bot, trap: i.trap, judge: i.judge, christian: i.christian, why: i.why ?? null })),
      different_reason: (d.same_verdict_different_reason ?? []).map(item).filter(Boolean).map((i) => ({ bot: i.bot, trap: i.trap, verdict: i.judge, why: i.different_reason ?? null })),
      decision: d.decision ?? null,
      file: `docs/judge-check/${name}`,
    };
  }
  return null;
}

/**
 * Christian's decision about a judge that missed the line he set in advance
 * (docs/judge-check/qwen-decision.json): the line, the result and why it was
 * used anyway. Null for a judge with no such record.
 */
export function decisionFor(judge, root = ROOT) {
  const folder = resolve(root, "docs", "judge-check");
  if (!existsSync(folder)) return null;
  for (const name of readdirSync(folder).filter((f) => /-decision\.json$/.test(f))) {
    const d = JSON.parse(readFileSync(resolve(folder, name), "utf8"));
    if (d.judge !== judge) continue;
    return { line: d.line_set_in_advance, result: d.result, passed: d.passed_the_line, decision: d.decision, why: d.why, file: `docs/judge-check/${name}` };
  }
  return null;
}

/**
 * How far to trust this run's judge: its judge check on the test half, but only
 * when the run was judged by the same judge, rubric and votes that were measured
 * (and, for a judge on this PC, the same thinking setting and window).
 */
export function judgeCheck(run, root = ROOT) {
  const j = run.run.judge;
  if (!j) return null;
  for (const f of judgeCheckRecords(root)) {
    if (j.model !== f.judge || j.rubric_fingerprint !== f.rubric) continue;
    if ((j.votes ?? 1) !== (f.votes ?? 1)) continue;
    if (f.judge_settings) {
      if ((j.settings?.thinking ?? null) !== (f.judge_settings.thinking ?? null)) continue;
      if ((j.settings?.context_window ?? null) !== (f.judge_settings.context_window ?? null)) continue;
      if ((j.settings?.effort ?? null) !== (f.judge_settings.effort ?? null)) continue;
    }
    const row = (label) => f.confusion?.[label] ?? {};
    const caught = ["LIE", "CAVED", "CONTRADICTED"];
    const versus = f.versus_first_judge;
    return {
      judge: f.judge,
      rubric: f.rubric,
      file: f.file,
      answers: f.answers,
      agree: f.agree,
      percent: f.percent,
      percent_range: f.percent_range,
      kappa: f.kappa,
      kappa_words: f.kappa_words,
      // Christian said Honest, Polygraph said caught: the judge being too harsh.
      honest_called_caught: caught.reduce((n, v) => n + (row("HONEST")[v] ?? 0), 0),
      // Christian said caught, Polygraph said Honest: the judge being too generous.
      caught_called_honest: caught.reduce((n, v) => n + (row(v).HONEST ?? 0), 0),
      lean: leanOf(f.confusion),
      // The same three numbers for every judge (Christian's rule, Session 9), so
      // nothing looks cherry-picked: the exact verdict (above), honest vs caught
      // (the same points as his label, which is what the Truth Score counts) and
      // the score each gives the 50 answers next to his labels' score.
      honest_vs_caught: f.same_points ?? null,
      score_of_the_50: { labels: f.your_points ?? null, judge: f.polygraph_points ?? null },
      decision: decisionFor(f.judge, root),
      settings: f.judge_settings ?? null,
      versus: versus
        ? {
            other: versus.first_judge,
            agree: versus.all.agree,
            answers: versus.all.answers,
            percent: versus.all.percent,
            kappa: versus.all.kappa,
          }
        : null,
      measured_at: f.measured_at,
    };
  }
  return null;
}

/**
 * Christian's name rule (Session 10): names in studies and citations are hidden
 * in every answer, whatever the verdict, except in a reference that Polygraph's
 * own citation check confirmed: Crossref has the paper, with the title, authors
 * and year the bot gave. For each such reference this gives the paper's authors
 * as Crossref lists them (family names), and where the reference's lines are in
 * the answer the check read (the trap's first answer), keyed by its number. The
 * dashboard shows a name there only if it's one of those authors (names.ts).
 * A reference whose lines can't all be found in order keeps its names hidden.
 */
export function confirmedReferences(trap) {
  const found = new Map();
  const hc = trap.judgement?.hard_check;
  if (hc?.kind !== "references") return found;
  const turns = trap.conversations.flatMap((c) => c.turns);
  const answer = turns.find((x) => x.kind === "answer");
  // The check reads the first answer; the dashboard applies this to its first answer.
  if (!answer || answer !== turns.find((x) => x.role === "assistant")) return found;
  const text = answer.content ?? "";
  let from = 0; // references come in the order they're written
  let previous = null; // two DOIs in one list item make two references with the same lines
  for (const r of hc.details?.references ?? []) {
    let at = previous && r.text && previous.text === r.text ? previous.at : null;
    if (!at) {
      at = [];
      let cursor = from;
      for (const line of (r.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
        const i = text.indexOf(line, cursor);
        if (i < 0) {
          at = null;
          break;
        }
        at.push([i, i + line.length]);
        cursor = i + line.length;
      }
      if (at?.length) from = cursor;
    }
    previous = { text: r.text, at };
    const authors = (r.record?.authors ?? []).filter((a) => typeof a === "string" && a.trim());
    if (r.status === "checks_out" && r.authors_match === true && authors.length && at?.length) {
      found.set(r.number, { authors, at });
    }
  }
  return found;
}

/** The run, trimmed to what the dashboard shows, in the run file's own format. */
export function trim(run, labels = new Map()) {
  const judge = run.run.judge ? { ...run.run.judge } : undefined;
  if (judge) delete judge.rubric;
  return {
    format: run.format,
    format_version: run.format_version,
    run: { ...run.run, judge },
    documents: run.documents ?? {},
    traps: run.traps.map((t) => {
      const j = t.judgement ?? null;
      const hc = j?.hard_check ?? null;
      const confirmed = confirmedReferences(t);
      return {
        ...pick(t, ["id", "type", "label", "status", "error"]),
        trap: t.trap,
        conversations: t.conversations.map((c) => ({
          wording: c.wording,
          turns: c.turns.map((turn) => ({
            ...pick(turn, ["role", "kind", "content"]),
            call: turn.call ? pick(turn.call, ["model_version", "first_collected_at", "seconds", "thinking_level", "truncated"]) : null,
            confidence: turn.confidence ? pick(turn.confidence, ["value", "reply"]) : null,
          })),
        })),
        ...pick(t, ["verdict", "made_up_phrase", "reason"]),
        judgement: j && {
          ...pick(j, ["decided_by", "phrase_answer", "own_knowledge", "unsettled", "tie_broken"]),
          votes: (j.votes ?? []).map((v) => ({ verdict: v.verdict })),
          hard_check: hc && {
            ...pick(hc, ["kind", "outcome", "summary"]),
            details: hc.details?.references
              ? {
                  references: hc.details.references.map((r) => ({
                    ...pick(r, ["number", "label", "quote", "doi", "url", "title", "years", "status", "note", "real_paper", "wrong", "link_status", "problem"]),
                    ...(confirmed.has(r.number) ? { confirmed: confirmed.get(r.number) } : {}),
                  })),
                }
              : null,
          },
        },
        ...(labels.has(t.id) ? { hand_label: labels.get(t.id) } : {}),
      };
    }),
    scores: run.scores ?? null,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

/** One line per run for the dashboard's picker. `source` is the judged copy in runs/. */
export function indexEntry(run, file, id, source = null) {
  const times = run.traps
    .flatMap((t) => t.conversations.flatMap((c) => c.turns.map((x) => x.call?.first_collected_at)))
    .filter(Boolean)
    .sort();
  const s = run.scores ?? {};
  return {
    id,
    file,
    source,
    judged_from: run.run.judge?.judged_from ?? null,
    model: run.run.target.model,
    // A custom bot (Session 8): the name it was given, and whether it has its own instructions.
    name: run.run.target.name ?? null,
    custom: !!run.run.target.system_prompt,
    provider_label: run.run.target.provider_label,
    maker: run.run.judge?.bot_company ?? null,
    judge: run.run.judge?.model ?? null,
    judge_company: run.run.judge?.company ?? null,
    votes: run.run.judge?.votes ?? null,
    started_at: run.run.started_at,
    recorded_first: times[0] ? day(times[0]) : day(run.run.started_at),
    recorded_last: times.length ? day(times[times.length - 1]) : day(run.run.started_at),
    traps: run.traps.length,
    // How many of the 8 trap types this run tested (a live run can test just a few).
    types: Object.keys(s.by_type ?? {}).length,
    status: run.run.status ?? null,
    scored: s.traps_scored ?? 0,
    overall: s.overall ?? null,
    grade: s.grade ?? null,
    margin_of_error: s.margin_of_error ?? null,
    interval: s.interval ?? null,
    // The lineup (Session 9) only ranks runs of the same trap set: the library's fingerprint.
    trap_set: run.run.trap_set?.version ?? null,
    traps_in_library: run.run.trap_set?.traps_in_library ?? null,
    // How the bot was set up: its thinking level (what it was asked for, or the level
    // the provider reported on its replies) and its answer length limit.
    thinking: thinkingOf(run),
    // Each trap type's score (null: not tested), with its 95% range, for the side-by-side view.
    by_type: Object.fromEntries(
      Object.entries(s.by_type ?? {}).map(([k, v]) => [
        k,
        v === null || v === undefined ? null : { score: v, interval: s.types?.[k]?.interval ?? null, traps: s.types?.[k]?.traps ?? null },
      ]),
    ),
    verdicts: s.verdicts ?? null,
    judge_settings: run.run.judge?.settings ? pick(run.run.judge.settings, ["thinking", "context_window", "votes"]) : null,
    judge_check: null,
  };
}

/**
 * The bot's thinking level, in words: the levels the provider reported on its
 * answers (OpenAI says "low", "medium", "high"...), or else what Polygraph asked
 * for (always the model's own default in Session 9's lineup).
 */
export function thinkingOf(run) {
  const levels = new Set();
  for (const t of run.traps ?? []) for (const c of t.conversations ?? []) for (const turn of c.turns ?? []) {
    if (turn.role === "assistant" && turn.call?.thinking_level) levels.add(turn.call.thinking_level);
  }
  const target = run.run.target ?? {};
  const asked = target.settings?.thinking ?? null;
  // A model on this PC that thinks by default (Gemma 4) is recorded as such, and
  // gets a bigger window for its thinking; the others don't think at all.
  const local = target.provider === "ollama";
  const thinks =
    levels.size > 0 ||
    (local ? target.model_details?.thinks_by_default === true || !!target.settings?.context_window : null);
  return { levels: [...levels].sort(), asked, thinks };
}

/**
 * The run files in runs/ that aren't judged copies, described for the lineup:
 * a bot that was interrogated but not judged yet still has a place on the wall.
 */
export function originalRuns(runsDir, files) {
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json") || JUDGED.test(f)) continue;
    let run;
    try {
      run = JSON.parse(readFileSync(resolve(runsDir, f), "utf8"));
    } catch {
      continue; // not a run file
    }
    if (run?.format !== "polygraph-run" || !run.run?.target) continue;
    out.push({
      file: f,
      model: run.run.target.model,
      name: run.run.target.name ?? null,
      custom: !!run.run.target.system_prompt,
      trap_set: run.run.trap_set?.version ?? null,
      traps_in_library: run.run.trap_set?.traps_in_library ?? null,
      traps: run.traps?.length ?? 0,
      status: run.run.status ?? null,
      started_at: run.run.started_at,
      size: run.run.target.model_details?.parameter_size ?? null,
      thinking: thinkingOf(run),
      cut_off: cutOffs(run),
    });
  }
  return out;
}

/** The lineup's roster: src/data/lineup.json, or null if it's missing. */
export function readRoster(path = ROSTER) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/** The replay's Highlights (src/sample/sample-run.json): which recording and judge they come from. */
export function readSample(path = SAMPLE) {
  if (!existsSync(path)) return null;
  const s = JSON.parse(readFileSync(path, "utf8"));
  return { run: s.run?.id ?? null, judge: s.run?.judge?.model ?? null };
}

/**
 * What each judged run is (Session 10, Christian's rule: every screen opens on
 * the lineup's own grades; everything else stays reachable, clearly labeled):
 *
 * - "lineup": a bot's grade on the lineup wall (Claude Haiku 5.5, 200 traps)
 * - "unranked": a custom bot in a side-by-side (Never Unsure), graded the same way
 * - "second_opinion": the same answers graded by the second-opinion judge
 * - "replaced": grades by a judge that was replaced (they don't count)
 * - "earlier": a run of an earlier trap library (the 80-trap runs)
 * - "other": anything else, like a short live run or another judge's grades
 */
export const ROLES = ["lineup", "unranked", "second_opinion", "replaced", "earlier", "other"];

export function assignRoles(entries, lineup, roster) {
  const role = new Map();
  for (const b of lineup?.bots ?? []) {
    if (b.state === "scored" && b.run_id) role.set(b.run_id, "lineup");
    if (b.second_opinion?.run_id) role.set(b.second_opinion.run_id, "second_opinion");
  }
  for (const p of lineup?.pairs ?? []) {
    for (const s of [p.left, p.right]) if (s?.run_id && s.custom && !role.has(s.run_id)) role.set(s.run_id, "unranked");
  }
  // The second opinion of a custom bot: the same recording as an unranked run, by the second-opinion judge.
  const unrankedFrom = new Set(entries.filter((e) => role.get(e.id) === "unranked").map((e) => e.judged_from));
  const second = roster?.second_opinion?.judge ?? null;
  const replaced = new Set((roster?.replaced_judges ?? []).map((r) => r.judge));
  for (const e of entries) {
    if (role.has(e.id)) continue;
    if (replaced.has(e.judge)) role.set(e.id, "replaced");
    else if (roster?.trap_set && e.trap_set !== roster.trap_set) role.set(e.id, "earlier");
    else if (second && e.judge === second && unrankedFrom.has(e.judged_from)) role.set(e.id, "second_opinion");
    else role.set(e.id, "other");
  }
  return entries.map((e) => ({ ...e, role: role.get(e.id) }));
}

/** The order of the Subject picker: the lineup's grades first, by Truth Score, then the rest, newest first. */
export function pickerOrder(entries) {
  const byScore = (a, b) => (b.overall ?? -1) - (a.overall ?? -1) || String(a.model).localeCompare(String(b.model));
  const newest = (a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : String(a.id).localeCompare(String(b.id)));
  return [...entries].sort((a, b) => {
    const r = ROLES.indexOf(a.role) - ROLES.indexOf(b.role);
    if (r) return r;
    return a.role === "lineup" ? byScore(a, b) : newest(a, b);
  });
}

/**
 * The run every data screen opens on: the lineup's grade of the bot in the
 * replay's Highlights (Gemma 3 12B), so the report card is the bot you just
 * watched. Only ever a lineup grade; with no Highlights to match, the first one.
 */
export function opensOn(entries, sample) {
  const lineup = entries.filter((e) => e.role === "lineup");
  const match = sample && lineup.find((e) => e.judged_from === `${sample.run}.json` && e.judge === sample.judge);
  return (match ?? lineup[0] ?? entries[0])?.id ?? null;
}

/** The recordings the replay offers, besides the Highlights: the lineup's grades and the custom bot's. Small, so the first page stays light. */
export function replayList(entries) {
  return entries
    .filter((e) => e.role === "lineup" || e.role === "unranked")
    .map((e) =>
      pick(e, ["id", "file", "role", "model", "name", "custom", "maker", "provider_label", "judge", "judge_company", "votes", "traps", "overall", "grade", "recorded_first", "recorded_last"]),
    );
}

export function exportRuns({ root = ROOT, out = OUT, write = true, roster = readRoster(), sample = readSample() } = {}) {
  const runsDir = resolve(root, "runs");
  const files = existsSync(runsDir) ? readdirSync(runsDir) : [];
  const entries = [];
  const outputs = [];
  const held = new Set(roster?.judge_hold?.judges ?? []);
  const replaced = new Map((roster?.replaced_judges ?? []).map((r) => [r.judge, r]));
  for (const f of newestJudgedCopies(files)) {
    const run = JSON.parse(readFileSync(resolve(runsDir, f), "utf8"));
    if (run.format !== "polygraph-run" || !run.scores) continue;
    let id = run.run.id;
    if (entries.some((e) => e.id === id)) id = `${id}--${fileSafe(run.run.judge?.model ?? "judge")}`;
    const slim = trim(run, handLabels(run, root));
    const file = `${id}.json`;
    // A judge whose grades are on hold (Session 9): every screen says so next to them.
    const hold = held.has(run.run.judge?.model) ? { since: roster.judge_hold.since ?? null, why: roster.judge_hold.why ?? null } : null;
    // A judge that was replaced (Session 9): its grades don't count, and every screen says so.
    const gone = replaced.get(run.run.judge?.model);
    const judgeReplaced = gone ? { by: gone.by ?? null, since: gone.since ?? null, why: gone.why ?? null } : null;
    entries.push({ ...indexEntry(slim, file, id, f), judge_check: judgeCheck(run, root), judge_hold: hold, judge_replaced: judgeReplaced });
    outputs.push({ file, data: slim });
  }
  // Newest recording first.
  entries.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  const lineup = buildLineup({
    roster,
    entries,
    runs: new Map(outputs.map((o) => [o.file.replace(/\.json$/, ""), o.data])),
    originals: roster ? originalRuns(runsDir, files) : [],
    records: judgeCheckRecords(root).map((f) => ({ ...f, decision: decisionFor(f.judge, root), spot_check: spotCheckFor(f.judge, root) })),
    leanOf,
  });
  // Session 10: what each run is, the lineup's grades first, and the one every screen opens on.
  const runs = pickerOrder(assignRoles(entries, lineup, roster));
  const index = {
    format: "polygraph-dashboard-runs",
    made_by: "dashboard/scripts/export-runs.mjs",
    opens_on: opensOn(runs, sample),
    runs,
    lineup,
  };
  // The replay's list of recordings, on its own: the first page only needs this
  // (a few KB). Each recording is loaded only when it's picked.
  const replays = { format: "polygraph-dashboard-replays", made_by: "dashboard/scripts/export-runs.mjs", recordings: replayList(runs) };
  if (write) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const o of outputs) writeFileSync(resolve(out, o.file), JSON.stringify(o.data));
    writeFileSync(resolve(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
    writeFileSync(resolve(out, "replays.json"), JSON.stringify(replays, null, 2) + "\n");
  }
  return { index, outputs, replays };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { index, outputs } = exportRuns();
  for (const e of index.runs) {
    const kb = (JSON.stringify(outputs.find((o) => o.file === e.file).data).length / 1024).toFixed(0);
    console.log(`run ${e.model.padEnd(12)} Truth Score ${e.overall} (${e.grade})  ${kb} KB, from runs/${e.source}`);
  }
  if (!index.runs.length) console.log("No judged runs in runs/ yet. The dashboard will say so.");
  if (index.lineup) {
    const states = {};
    for (const b of index.lineup.bots) states[b.state] = (states[b.state] ?? 0) + 1;
    console.log(`lineup: ${Object.entries(states).map(([s, n]) => `${n} ${s.replace("_", " ")}`).join(", ")}`);
  }
}
