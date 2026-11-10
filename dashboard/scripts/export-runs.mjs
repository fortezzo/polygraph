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

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..", "..");
const OUT = resolve(here, "..", "public", "runs");

const JUDGED = /^(.*)_judged-by_(.+?)(?:~(\d+))?\.json$/;

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

/** Christian's hand labels for this run's traps, from the Session 5 judge check. */
export function handLabels(run, root = ROOT) {
  const pickPath = resolve(root, "docs", "judge-check", "sample.json");
  const labelPath = resolve(root, "docs", "judge-check", "labels.json");
  if (!existsSync(pickPath) || !existsSync(labelPath)) return new Map();
  const jc = JSON.parse(readFileSync(pickPath, "utf8"));
  const labels = JSON.parse(readFileSync(labelPath, "utf8")).labels;
  const original = run.run.judge?.judged_from;
  const jcRun = jc.runs.find((r) => basename(r.path) === original);
  const out = new Map();
  if (!jcRun) return out;
  for (const it of jc.items) {
    if (it.run !== jcRun.key || !labels[it.id]) continue;
    out.set(it.trap, { verdict: labels[it.id].verdict, unsure: !!labels[it.id].unsure, item: it.id });
  }
  return out;
}

/**
 * How far to trust this run's judge: the Session 5 judge check, but only when the
 * run was judged by the same judge with the same rubric that was measured.
 */
export function judgeCheck(run, root = ROOT) {
  const path = resolve(root, "docs", "judge-check", "final.json");
  if (!existsSync(path)) return null;
  const f = JSON.parse(readFileSync(path, "utf8"));
  const j = run.run.judge;
  if (!j || j.model !== f.judge || j.rubric_fingerprint !== f.rubric) return null;
  const row = (label) => f.confusion?.[label] ?? {};
  const caught = ["LIE", "CAVED", "CONTRADICTED"];
  return {
    judge: f.judge,
    rubric: f.rubric,
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
    measured_at: f.measured_at,
  };
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
      return {
        ...pick(t, ["id", "type", "label", "status", "error"]),
        trap: t.trap,
        conversations: t.conversations.map((c) => ({
          wording: c.wording,
          turns: c.turns.map((turn) => ({
            ...pick(turn, ["role", "kind", "content"]),
            call: turn.call ? pick(turn.call, ["model_version", "first_collected_at", "seconds"]) : null,
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
                  references: hc.details.references.map((r) =>
                    pick(r, ["number", "label", "quote", "doi", "url", "title", "years", "status", "note", "real_paper", "wrong", "link_status", "problem"]),
                  ),
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
    provider_label: run.run.target.provider_label,
    maker: run.run.judge?.bot_company ?? null,
    judge: run.run.judge?.model ?? null,
    judge_company: run.run.judge?.company ?? null,
    votes: run.run.judge?.votes ?? null,
    started_at: run.run.started_at,
    recorded_first: times[0] ? day(times[0]) : day(run.run.started_at),
    recorded_last: times.length ? day(times[times.length - 1]) : day(run.run.started_at),
    traps: run.traps.length,
    scored: s.traps_scored ?? 0,
    overall: s.overall ?? null,
    grade: s.grade ?? null,
    margin_of_error: s.margin_of_error ?? null,
    judge_check: null,
  };
}

export function exportRuns({ root = ROOT, out = OUT, write = true } = {}) {
  const runsDir = resolve(root, "runs");
  const files = existsSync(runsDir) ? readdirSync(runsDir) : [];
  const entries = [];
  const outputs = [];
  for (const f of newestJudgedCopies(files)) {
    const run = JSON.parse(readFileSync(resolve(runsDir, f), "utf8"));
    if (run.format !== "polygraph-run" || !run.scores) continue;
    let id = run.run.id;
    if (entries.some((e) => e.id === id)) id = `${id}--${run.run.judge?.model ?? "judge"}`;
    const slim = trim(run, handLabels(run, root));
    const file = `${id}.json`;
    entries.push({ ...indexEntry(slim, file, id, f), judge_check: judgeCheck(run, root) });
    outputs.push({ file, data: slim });
  }
  // Newest recording first.
  entries.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  const index = { format: "polygraph-dashboard-runs", made_by: "dashboard/scripts/export-runs.mjs", runs: entries };
  if (write) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const o of outputs) writeFileSync(resolve(out, o.file), JSON.stringify(o.data));
    writeFileSync(resolve(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  }
  return { index, outputs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { index, outputs } = exportRuns();
  for (const e of index.runs) {
    const kb = (JSON.stringify(outputs.find((o) => o.file === e.file).data).length / 1024).toFixed(0);
    console.log(`run ${e.model.padEnd(12)} Truth Score ${e.overall} (${e.grade})  ${kb} KB, from runs/${e.source}`);
  }
  if (!index.runs.length) console.log("No judged runs in runs/ yet. The dashboard will say so.");
}
