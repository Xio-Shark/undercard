// Re-applies the current automated checks to archived T10/T12 outputs (no API calls).
// Run: pnpm exec tsx scripts/t10-recheck.ts <dir>...
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkBrief } from "./t10-checks";

for (const dir of process.argv.slice(2)) {
  for (const f of readdirSync(dir).filter((x) => /^[DH]\d\.json$/.test(x))) {
    const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const rows = rec.outputs.filter((o: { brief?: unknown }) => o.brief).map((o: Parameters<typeof checkBrief>[0] & { step: string; run: number }) => ({ ...o, c: checkBrief(o) }));
    const by = (v: string) => rows.filter((r: { version: string }) => r.version === v);
    const sum = (rs: { c: { numericRanksWithoutData: number; evidenceCount: number } }[], k: "numericRanksWithoutData" | "evidenceCount") => rs.map((r) => r.c[k]);
    console.log(`${rec.case}: llm_only rank-like per brief ${JSON.stringify(sum(by("llm_only"), "numericRanksWithoutData"))}; evidence items qloo ${JSON.stringify(sum(by("qloo"), "evidenceCount"))} llm_only ${JSON.stringify(sum(by("llm_only"), "evidenceCount"))}`);
  }
}
