// Builds the dashboard's sample interrogation from a real judged run file.
//
// Christian's rule (Session 6): the sample only uses answers where Polygraph's
// verdict matches his own hand label from the Session 5 judge check. This
// script refuses an answer he didn't label, marked "not sure", or labeled
// differently, and (as the 6 were picked) a split vote or a verdict resting on
// the judge's own knowledge. Nothing is retyped by hand: every word comes from
// the run file.
//
// Session 10: the Highlights are the lineup judge's grades (Claude Haiku 5.5) of
// Gemma 3 12B's 200-trap run, which reused the labeled answers word for word.
// A reused answer only counts when every word matches the one he labeled.
//
// Run it from the dashboard folder:  npm run sample

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..", "..");

export const SAMPLE_RUN =
  "runs/2026-11-10_13-08-46_ollama_gemma3-12b_judged-by_claude-haiku-5-5.json";

// The order they play in.
export const SAMPLE_TRAPS = [
  "number-005",
  "ghost-004",
  "consistency-003",
  "pressure-002",
  "document-004",
  // Session 10: limits-005 (Caesar's blood type) left the Highlights. Christian
  // labeled it a Lie, and Claude Haiku 5.5 called it Honest (2 votes to 1).
  "limits-002",
];

const OUT_JSON = "dashboard/src/sample/sample-run.json";
// The Session 6 mockups (docs/design/directions/sample.js) keep the sample they
// were drawn with: they're the record of how the look was chosen.

const readJson = (relPath) =>
  JSON.parse(readFileSync(resolve(ROOT, relPath), "utf8"));

/** Every word of a trap's conversations: who said it, what kind of turn, and the text. */
const wordsOf = (trap) =>
  JSON.stringify((trap?.conversations ?? []).map((c) => c.turns.map((t) => [t.role, t.kind, t.content])));

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/** Checks Christian's rule for every trap, then returns the trimmed run. */
export function buildSample({
  runPath = SAMPLE_RUN,
  trapIds = SAMPLE_TRAPS,
  labelsPath = "docs/judge-check/labels.json",
  pickPath = "docs/judge-check/sample.json",
} = {}) {
  const run = readJson(runPath);
  const labels = readJson(labelsPath).labels;
  const jc = readJson(pickPath);

  // Which run in the judge check is this? The judged copy names its original,
  // and a run made with --reuse names the run whose answers it reused.
  const original = run.run.judge?.judged_from;
  if (!original) throw new Error(`${runPath} is not a judged copy.`);
  let jcRun = jc.runs.find((r) => basename(r.path) === original);
  let labeled = null;
  if (!jcRun && run.run.reused_from) {
    jcRun = jc.runs.find((r) => basename(r.path) === run.run.reused_from);
    if (jcRun) labeled = new Map(readJson(jcRun.path).traps.map((t) => [t.id, t]));
  }
  if (!jcRun) throw new Error(`${original} was not part of the judge check.`);

  const byId = new Map(run.traps.map((t) => [t.id, t]));
  const problems = [];
  const checked = [];
  for (const id of trapIds) {
    const t = byId.get(id);
    if (!t) { problems.push(`${id}: not in ${runPath}`); continue; }
    const item = jc.items.find((it) => it.run === jcRun.key && it.trap === id);
    if (!item) { problems.push(`${id}: Christian didn't label it (it isn't in the 100)`); continue; }
    const label = labels[item.id];
    if (!label) { problems.push(`${id}: ${item.id} has no label`); continue; }
    if (label.unsure) problems.push(`${id}: ${item.id} is marked "not sure"`);
    if (!t.verdict) problems.push(`${id}: Polygraph gave no verdict`);
    else if (label.verdict !== t.verdict)
      problems.push(`${id}: Polygraph says ${t.verdict}, Christian's label says ${label.verdict}`);
    if (t.judgement?.unsettled) problems.push(`${id}: the verdict is an unsettled tie`);
    const votes = (t.judgement?.votes ?? []).map((v) => v.verdict);
    if (votes.some((v) => v !== t.verdict)) problems.push(`${id}: a split vote (${votes.join(", ")})`);
    if (t.judgement?.own_knowledge) problems.push(`${id}: the verdict rests on the judge's own knowledge (⚑)`);
    if (labeled && wordsOf(t) !== wordsOf(labeled.get(id)))
      problems.push(`${id}: the answer isn't word for word the one Christian labeled`);
    checked.push({ trap: id, item: item.id, half: item.half, label: label.verdict, verdict: t.verdict });
  }
  if (problems.length) {
    throw new Error("These answers can't go in the sample:\n  " + problems.join("\n  "));
  }

  const traps = trapIds.map((id) => {
    const t = byId.get(id);
    return {
      ...pick(t, ["id", "type", "label", "status"]),
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
      judgement: {
        ...pick(t.judgement, ["decided_by", "phrase_answer", "own_knowledge", "unsettled"]),
        votes: (t.judgement.votes ?? []).map((v) => ({ verdict: v.verdict })),
      },
    };
  });

  const docIds = new Set(traps.map((t) => t.trap.document).filter(Boolean));
  const documents = Object.fromEntries(
    Object.entries(run.documents ?? {}).filter(([k]) => docIds.has(k)),
  );

  const r = run.run;
  return {
    format: run.format,
    format_version: run.format_version,
    sample: {
      made_from: runPath,
      made_by: "dashboard/scripts/make-sample.mjs",
      rule: "Only answers where Polygraph's verdict matches Christian's hand label from the Session 5 judge check.",
      ...(labeled ? { labeled_in: jcRun.path, reused: "Every answer is word for word the one Christian labeled." } : {}),
      checked,
    },
    run: {
      ...pick(r, ["id", "status", "started_at", "finished_at"]),
      target: {
        ...pick(r.target, ["provider", "provider_label", "model", "model_version"]),
        model_details: pick(r.target.model_details ?? {}, ["family", "parameter_size", "quantization_level"]),
      },
      judge: pick(r.judge, [
        "provider_label", "model", "model_version", "company", "bot_company",
        "rubric_fingerprint", "hard_checks_version", "votes",
      ]),
      trap_set: pick(r.trap_set, ["version", "traps_in_run"]),
      prompts: r.prompts,
    },
    documents,
    traps,
  };
}

function main() {
  const sample = buildSample();
  const json = JSON.stringify(sample, null, 2) + "\n";
  for (const [rel, text] of [[OUT_JSON, json]]) {
    const abs = resolve(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf8");
    console.log(`wrote ${rel} (${(text.length / 1024).toFixed(1)} KB)`);
  }
  console.log(`\nFrom ${SAMPLE_RUN}`);
  for (const c of sample.sample.checked) {
    console.log(`  ${c.trap.padEnd(16)} ${c.item}  ${c.half.padEnd(6)} half   Polygraph ${c.verdict.padEnd(7)} Christian ${c.label}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
