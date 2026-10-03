// T05 ablation on the frozen D1/D2 cases: same model, instructions, list and constraints; only Qloo evidence differs.
// Qloo version = the product pipeline (lib/audit.ts) + brief writer (lib/llm.ts). LLM-only version gets no evidence.
// Run: pnpm t05 [D1|D2]. Raw outputs go to .probe/t05/<timestamp>/ (git-ignored).
// Note: the recorded 2026-10-03T04-47 run predates this refactor (compare tags were not yet de-duplicated by name).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit, type AuditInput } from "../lib/audit";
import { writeBrief } from "../lib/llm";
import { QlooMcp } from "../lib/qloo-mcp";

interface Case {
  id: string;
  headliner: string;
  references: string[];
  shortlist: string[];
  confirmed?: Record<string, string>;
  question: string;
}
type Json = Record<string, unknown>;

const RUNS_PER_VERSION = 2;
const runDir = join(".probe", "t05", new Date().toISOString().replace(/[:.]/g, "-"));

async function qlooEvidence(mcp: QlooMcp, c: Case): Promise<Json> {
  const input: AuditInput = { headliner: c.headliner, references: c.references, shortlist: c.shortlist, confirmations: c.confirmed };
  let result = await runAudit(mcp, input);
  let notRankableByQloo: string[] = [];
  if (result.status === "partial") {
    // Product flow: partial is reported; the user removes the unranked candidates and a new query runs.
    notRankableByQloo = result.missing;
    const missing = new Set(result.missingInputs);
    result = await runAudit(mcp, { ...input, shortlist: c.shortlist.filter((n) => !missing.has(n)) });
  }
  if (result.status !== "complete") throw new Error(`${c.id}: audit ended with ${result.status}: ${JSON.stringify(result).slice(0, 300)}`);
  return {
    notRankableByQloo,
    poolSize: result.pool.length,
    table: result.table.map((r) => ({ candidate: r.name, headlinerRank: r.headlinerRank, targetRank: r.targetRank, worstRank: r.worstRank })),
    priority: result.priority.name,
    backups: result.backups.map((b) => b.name),
    audienceComparison: result.evidence,
  };
}

function caseText(c: Case): string {
  return [
    `Headliner: ${c.headliner}.`,
    `Target audience reference artists: ${c.references.join(", ")}.`,
    `Shortlist (pre-screened by the team): ${c.shortlist.join(", ")}.`,
    `Team question: ${c.question}`,
  ].join("\n");
}

async function main(): Promise<void> {
  for (const k of ["QLOO_API_KEY", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"]) if (!process.env[k]) throw new Error(`${k} missing`);
  mkdirSync(runDir, { recursive: true });
  const { cases } = JSON.parse(readFileSync("scripts/t04-cases.json", "utf8")) as { cases: Case[] };
  const only = process.argv[2];
  const mcp = new QlooMcp();
  try {
    for (const c of cases.filter((x) => !only || x.id === only)) {
      const evidence = await qlooEvidence(mcp, c);
      const runs: Json[] = [];
      for (let i = 1; i <= RUNS_PER_VERSION; i++) {
        for (const version of ["qloo", "llm_only"] as const) {
          try {
            const b = await writeBrief({ caseText: caseText(c), evidence: version === "qloo" ? evidence : null, language: "Chinese" });
            const keptServerPriority = version === "qloo" ? b.brief.priority === evidence.priority : null;
            runs.push({ version, run: i, keptServerPriority, ms: b.ms, usage: b.usage, output: b.brief });
          } catch (e) {
            // A malformed brief is a recorded failure for this run, not a reason to drop the comparison.
            runs.push({ version, run: i, failed: e instanceof Error ? e.message.slice(0, 500) : String(e) });
          }
        }
      }
      const record = { case: c.id, model: process.env.LLM_MODEL, evidence, runs };
      writeFileSync(join(runDir, `${c.id}.json`), JSON.stringify(record, null, 2));
      console.log(JSON.stringify(record, null, 2));
    }
  } finally {
    mcp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
