// T10: repeatable with/without-Qloo comparison on frozen cases, including the frozen feedback script.
// Same model, instructions, case text (one builder, lib/replan.ts caseText) and effective shortlist; only
// the Qloo evidence differs. Feedback per case (Task/evidence/T04-cases.md):
//   ① each version vetoes ITS OWN initial priority with the frozen reason;
//   ② target references are changed as frozen; the Qloo version re-queries for real, vetoes carry over.
// Run: pnpm t10 [caseId...]   Env: T10_RUNS (default 2), T10_CASES (default scripts/t04-cases.json).
// Raw outputs + summary.md go to .probe/t10/<timestamp>/ (git-ignored). Failures are recorded, not retried.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit, type QlooCaller } from "../lib/audit";
import { writeBrief, type Brief } from "../lib/llm";
import { QlooMcp } from "../lib/qloo-mcp";
import { briefInput, caseText, currentResult, inPlayNames, stateFromQuery, vetoRun, type RunState, type VetoReason } from "../lib/replan";
import { allPass, checkBrief, type Checks } from "./t10-checks";

interface Case {
  id: string;
  headliner: string;
  references: string[];
  shortlist: string[];
  confirmed?: Record<string, string>;
  question: string;
  veto: VetoReason;
  modifiedReferences: string[];
  /** Acts with no matching Qloo entity (recorded in the freeze log); out of both versions' effective list. */
  unresolvable?: string[];
}
type Step = "initial" | "after_veto" | "edited_references";
type Version = "qloo" | "llm_only";
interface Output {
  case: string; step: Step; version: Version; run: number;
  inPlay: string[]; vetoed: string[]; rulePriority?: string;
  brief?: Brief; failed?: string; skipped?: string; checks?: Checks; ms?: number;
  /** Model attempts (1 = first output valid) and why earlier outputs were rejected. */
  attempts?: number; malformed?: string[];
}

const RUNS = Number(process.env.T10_RUNS ?? 2);
const LANGUAGE = "English";
const runDir = join(".probe", "t10", new Date().toISOString().replace(/[:.]/g, "-"));

/** Counts Qloo tool calls per tool so cost is recorded next to the outputs. */
function counted(mcp: QlooMcp) {
  const calls: Record<string, number> = {};
  const caller: QlooCaller = { call: (name, args, signal) => ((calls[name] = (calls[name] ?? 0) + 1), mcp.call(name, args, signal)) };
  return { caller, calls };
}

/** A real query, following the product flow on partial: report the unrankable acts, remove them, query again. */
async function query(mcp: QlooCaller, c: Case, shortlist: string[], references: string[], previous?: RunState) {
  let input = { headliner: c.headliner, references, shortlist, confirmations: c.confirmed, question: c.question, language: LANGUAGE as "English" };
  const vetoedIds = previous?.vetoes.map((v) => v.id);
  let result = await runAudit(mcp, { ...input, vetoedIds });
  let notRankable: string[] = [];
  if (result.status === "partial") {
    notRankable = result.missing;
    const drop = new Set(result.missingInputs);
    input = { ...input, shortlist: shortlist.filter((n) => !drop.has(n)) };
    result = await runAudit(mcp, { ...input, vetoedIds });
  }
  if (result.status !== "complete") throw new Error(`${c.id}: query ended with ${result.status}: ${JSON.stringify(result).slice(0, 300)}`);
  return { state: stateFromQuery(input, result, new Date().toISOString(), previous), notRankable };
}

async function brief(o: Omit<Output, "brief" | "checks" | "ms">, text: string, evidence: unknown | null): Promise<Output> {
  try {
    const b = await writeBrief({ caseText: text, evidence, language: LANGUAGE });
    return { ...o, brief: b.brief, ms: b.ms, attempts: b.attempts, malformed: b.malformed, checks: checkBrief({ version: o.version, brief: b.brief, inPlay: o.inPlay, vetoed: o.vetoed, rulePriority: o.rulePriority }) };
  } catch (e) {
    return { ...o, failed: e instanceof Error ? e.message.slice(0, 500) : String(e) };
  }
}

const runs = () => Array.from({ length: RUNS }, (_, i) => i + 1);

/** Qloo version for one state: the product's own case text and evidence. */
function qlooBriefs(c: Case, step: Step, state: RunState): Promise<Output[]> {
  const current = currentResult(state);
  if (!current) return Promise.resolve([{ case: c.id, step, version: "qloo", run: 0, inPlay: [], vetoed: state.vetoes.map((v) => v.name), skipped: "pool empty" }]);
  const { caseText: text, evidence } = briefInput(state, current);
  const base = { case: c.id, step, version: "qloo" as const, inPlay: inPlayNames(current), vetoed: state.vetoes.map((v) => v.name), rulePriority: current.priority.name };
  return Promise.all(runs().map((run) => brief({ ...base, run }, text, evidence)));
}

/** LLM-only version: identical case text builder and effective list, no evidence. */
function llmBrief(c: Case, step: Step, run: number, s: { headliner: string; references: string[]; inPlay: string[]; veto?: string }): Promise<Output> {
  const vetoed = s.veto ? [{ name: s.veto, reason: c.veto }] : [];
  const inPlay = s.inPlay.filter((n) => n !== s.veto);
  const text = caseText({ headliner: s.headliner, references: s.references, inPlay, vetoed, question: c.question });
  return brief({ case: c.id, step, version: "llm_only", run, inPlay, vetoed: vetoed.map((v) => v.name) }, text, null);
}

async function runCase(mcp: QlooCaller, c: Case) {
  const q0 = await query(mcp, c, c.shortlist.filter((n) => !c.unresolvable?.includes(n)), c.references);
  const cur0 = currentResult(q0.state)!;
  const names = { headliner: cur0.headliner.name, references: cur0.references.map((r) => r.name), inPlay: inPlayNames(cur0) };
  const outputs: Output[] = [];
  const [qInit, lInit] = await Promise.all([qlooBriefs(c, "initial", q0.state), Promise.all(runs().map((run) => llmBrief(c, "initial", run, names)))]);
  outputs.push(...qInit, ...lInit);

  // ① each version vetoes its own initial priority (the Qloo rule's choice is deterministic: one veto for all runs).
  const s1 = await vetoRun(mcp, q0.state, { id: cur0.priority.id, reason: c.veto });
  // Map the model's spelling back to the shortlist's (case-insensitive); unknown names give no veto.
  const llmVeto = (run: number) => {
    const p = lInit.find((o) => o.run === run)?.brief?.priority?.trim().toLowerCase();
    return names.inPlay.find((n) => n.toLowerCase() === p);
  };
  const skipped = (run: number): Output => ({ case: c.id, step: "after_veto", version: "llm_only", run, inPlay: names.inPlay, vetoed: [], skipped: "initial run gave no valid priority to veto" });
  const [qVeto, lVeto] = await Promise.all([
    qlooBriefs(c, "after_veto", s1),
    Promise.all(runs().map((run) => { const v = llmVeto(run); return v && names.inPlay.includes(v) ? llmBrief(c, "after_veto", run, { ...names, veto: v }) : Promise.resolve(skipped(run)); })),
  ]);
  outputs.push(...qVeto, ...lVeto);

  // ② edited references: a real re-query for the Qloo version (vetoes carried); same new references for LLM-only.
  const q2 = await query(mcp, c, q0.state.input.shortlist, c.modifiedReferences, s1);
  const cur2 = currentResult(q2.state)!;
  const newlyUnrankable = new Set(q2.notRankable);
  const refs2 = cur2.references.map((r) => r.name);
  const [qEdit, lEdit] = await Promise.all([
    qlooBriefs(c, "edited_references", q2.state),
    Promise.all(runs().map((run) => { const v = llmVeto(run); return llmBrief(c, "edited_references", run, { ...names, references: refs2, inPlay: names.inPlay.filter((n) => !newlyUnrankable.has(n)), veto: v && names.inPlay.includes(v) ? v : undefined }); })),
  ]);
  outputs.push(...qEdit, ...lEdit);

  const ranks = (s: RunState) => currentResult(s)?.table.map((r) => ({ name: r.name, headlinerRank: r.headlinerRank, targetRank: r.targetRank, tied: !!r.tiedWithPrevious }));
  return {
    qloo: {
      initial: { notRankable: q0.notRankable, table: ranks(q0.state), priority: cur0.priority.name },
      afterVeto: { vetoed: cur0.priority.name, table: ranks(s1), priority: currentResult(s1)?.priority.name ?? null, explanationRefetched: s1.explanation?.refetched ?? null },
      editedReferences: { references: refs2, notRankable: q2.notRankable, table: ranks(q2.state), priority: cur2.priority.name, change: q2.state.change },
    },
    outputs,
  };
}

function summaryRows(caseId: string, outputs: Output[]): string[] {
  return outputs.map((o) => {
    const retried = (o.attempts ?? 1) > 1 ? " (after 1 malformed output)" : "";
    const status = o.failed ? `FAILED: ${o.failed.slice(0, 80)}` : o.skipped ? `skipped: ${o.skipped}` : (allPass(o.checks!) ? "pass" : `FAIL ${JSON.stringify(o.checks)}`) + retried;
    const pick = o.brief ? `${o.brief.priority ?? "(none)"}${o.brief.backups.length ? ` / ${o.brief.backups.join(", ")}` : ""}` : "—";
    return `| ${caseId} | ${o.step} | ${o.version} | ${o.run} | ${o.vetoed.join(", ") || "—"} | ${pick} | ${status} |`;
  });
}

async function main(): Promise<void> {
  for (const k of ["QLOO_API_KEY", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"]) if (!process.env[k]) throw new Error(`${k} missing`);
  mkdirSync(runDir, { recursive: true });
  const { cases } = JSON.parse(readFileSync(process.env.T10_CASES ?? "scripts/t04-cases.json", "utf8")) as { cases: Case[] };
  const only = process.argv.slice(2);
  const mcp = new QlooMcp();
  const rows = ["| Case | Step | Version | Run | Vetoed | Priority / backups | Automated checks |", "|---|---|---|---|---|---|---|"];
  try {
    for (const c of cases.filter((x) => only.length === 0 || only.includes(x.id))) {
      const { caller, calls } = counted(mcp);
      const started = Date.now();
      const record = { case: c.id, model: process.env.LLM_MODEL, runsPerVersion: RUNS, ...(await runCase(caller, c)), qlooToolCalls: calls, ms: Date.now() - started };
      writeFileSync(join(runDir, `${c.id}.json`), JSON.stringify(record, null, 2));
      rows.push(...summaryRows(c.id, record.outputs));
      console.log(`${c.id}: done in ${(record.ms / 1000).toFixed(0)} s, Qloo tool calls ${JSON.stringify(calls)}`);
    }
  } finally {
    mcp.close();
    writeFileSync(join(runDir, "summary.md"), rows.join("\n") + "\n");
    console.log(`${runDir}/summary.md\n${rows.join("\n")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
