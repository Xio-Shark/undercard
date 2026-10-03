// T04 probe through the official harness MCP server (`qloo mcp`, the production path).
// Run: pnpm probe:t04 [D1|D2]   (reads QLOO_* from .env.local; QLOO_HOME stays inside the app folder)
// Raw responses go to .probe/t04/<timestamp>/ (git-ignored). Evidence gets only redacted conclusions.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectionOrder as select } from "../lib/selection";
import { QlooMcp } from "../lib/qloo-mcp";

interface Case {
  id: string;
  headliner: string;
  references: string[];
  shortlist: string[];
  veto: string;
  modifiedReferences: string[];
  confirmed?: Record<string, string>;
}
interface Resolved { input: string; status: string; id?: string; name?: string; match?: string; alternatives: number }
interface SideRanks { ranks: Map<string, number>; missing: string[]; issues: string[] }
type Json = Record<string, unknown>;

const runDir = join(".probe", "t04", new Date().toISOString().replace(/[:.]/g, "-"));
const calls: { label: string; tool: string; ms: number; status: string }[] = [];
const rateLimitEvents: { label: string; waitedMs: number; recovered: boolean }[] = [];
const PACE_MS = 1500; // hackathon limit is 5 requests/s (x-second-ratelimit-limit); one tool call can fan out
// The harness already retries 429 within 30s; beyond that, back off further but stay bounded.
const RATE_LIMIT_WAITS_MS = [60_000, 120_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let mcp: QlooMcp;

const errorCode = (out: Json) => (out.error as { code?: string } | undefined)?.code;

async function qloo(tool: string, args: Json, label: string): Promise<Json> {
  const started = Date.now();
  await sleep(PACE_MS);
  let out = await mcp.call(tool, args);
  for (const wait of RATE_LIMIT_WAITS_MS) {
    if (errorCode(out) !== "QLOO_RATE_LIMIT") break;
    await sleep(wait);
    out = await mcp.call(tool, args);
    rateLimitEvents.push({ label, waitedMs: wait, recovered: errorCode(out) !== "QLOO_RATE_LIMIT" });
  }
  writeFileSync(join(runDir, `${String(calls.length + 1).padStart(3, "0")}-${label}.json`), JSON.stringify(out));
  calls.push({ label, tool, ms: Date.now() - started, status: String(out.status ?? errorCode(out)) });
  if (out.status === undefined) throw new Error(`${tool} ${label} failed: ${JSON.stringify(out.error ?? out).slice(0, 300)}`);
  return out;
}

async function describe(name: string, label: string, confirmed: Record<string, string>): Promise<Resolved> {
  let out = await qloo("qloo_describe", { entity: name, type: "artist" }, label);
  const firstStatus = String(out.status);
  if (out.status === "needs_input") {
    // Never drop an ambiguous candidate silently: it needs a recorded user confirmation.
    const choice = confirmed[name];
    if (!choice) throw new Error(`needs_input for "${name}" and no confirmation in t04-cases.json`);
    out = await qloo("qloo_describe", { entity: choice, type: "artist" }, `${label}-confirmed`);
  }
  const outcome = ((out.resolution as Json)?.outcomes as Json[] | undefined)?.[0] ?? {};
  const entity = (out.interpretation as Json)?.entity as Json | undefined;
  return {
    input: name,
    status: firstStatus === "needs_input" ? `needs_input→${out.status}` : String(out.status),
    id: entity?.entityId as string | undefined,
    name: entity?.name as string | undefined,
    match: entity?.match as string | undefined,
    alternatives: ((outcome.alternatives as unknown[]) ?? []).length,
  };
}

async function rankSide(pool: string[], signals: string[], label: string): Promise<SideRanks> {
  const out = await qloo("qloo_rank", { options: pool, option_type: "artist", signals }, label);
  const ranks = new Map<string, number>();
  const issues: string[] = out.status === "ok" ? [] : [`status=${out.status}`];
  ((out.results as Json[]) ?? []).forEach((r, i) => {
    const id = r.entity_id as string;
    if (!pool.includes(id)) issues.push(`out-of-pool ${id}`);
    if (ranks.has(id)) issues.push(`duplicate ${id}`);
    ranks.set(id, i + 1);
  });
  return { ranks, missing: pool.filter((id) => !ranks.has(id)), issues };
}

const rotated = <T,>(xs: T[]): T[] => {
  const r = [...xs].reverse(); // deterministic reorder: reverse + rotate
  return [...r.slice(1), r[0]];
};
const sameRanks = (x: Map<string, number>, y: Map<string, number>) =>
  x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);

async function compare(groupA: string[], top: string, label: string): Promise<Json> {
  const out = await qloo("qloo_compare_audiences", { group_a: groupA, group_b: [top], target_type: "artist" }, label);
  // results = { tags: shared tags with a similarity score, a/b: each group's own tags, matchEntities }.
  const r = (out.results ?? {}) as { tags?: Json[]; a?: Json[]; b?: Json[]; matchEntities?: unknown[] };
  const tagNames = (xs: Json[] | undefined) => (xs ?? []).map((t) => String(t.name));
  const aNames = new Set(tagNames(r.a));
  const bNames = new Set(tagNames(r.b));
  return {
    status: out.status,
    shared: (r.tags ?? []).slice(0, 8).map((t) => `${t.name} (${Number((t.query as Json)?.score ?? 0).toFixed(2)})`),
    onlyA: [...aNames].filter((n) => !bNames.has(n)).slice(0, 6),
    onlyB: [...bNames].filter((n) => !aNames.has(n)).slice(0, 6),
    counts: { shared: r.tags?.length ?? 0, a: aNames.size, b: bNames.size, matchEntities: r.matchEntities?.length ?? 0 },
  };
}

interface Audit {
  status: "complete" | "partial";
  poolSize: number;
  missing: string[];
  issues: string[];
  stable: { A: boolean; B: boolean };
  ranksA: Json;
  ranksB: Json;
  order: string[];
  rA: Map<string, number>;
  rB: Map<string, number>;
}

/** Two-sided audit of one pool: stability repeats, then selection. Partial pools stop before selection. */
async function audit(tag: string, pool: string[], A: string[], B: string[], names: Map<string, string>, repeats: number): Promise<Audit> {
  const sides = { A: [] as SideRanks[], B: [] as SideRanks[] };
  for (let i = 1; i <= repeats; i++) {
    sides.A.push(await rankSide(pool, A, `${tag}-rankA-rep${i}`));
    sides.B.push(await rankSide(pool, B, `${tag}-rankB-rep${i}`));
  }
  if (repeats > 1) {
    sides.A.push(await rankSide(rotated(pool), A, `${tag}-rankA-reordered`));
    sides.B.push(await rankSide(rotated(pool), B, `${tag}-rankB-reordered`));
  }
  const [rA, rB] = [sides.A[0], sides.B[0]];
  const missing = [...new Set([...rA.missing, ...rB.missing])].map((id) => names.get(id) ?? id);
  const issues = [...sides.A, ...sides.B].flatMap((s) => s.issues);
  const stable = { A: sides.A.every((s) => sameRanks(s.ranks, rA.ranks)), B: sides.B.every((s) => sameRanks(s.ranks, rB.ranks)) };
  const named = (s: SideRanks) => Object.fromEntries([...s.ranks].map(([id, r]) => [names.get(id), r]));
  const complete = missing.length === 0 && issues.length === 0;
  return {
    status: complete ? "complete" : "partial",
    poolSize: pool.length,
    missing,
    issues,
    stable,
    ranksA: named(rA),
    ranksB: named(rB),
    order: complete ? select(pool, rA.ranks, rB.ranks) : [],
    rA: rA.ranks,
    rB: rB.ranks,
  };
}

const table = (names: Map<string, string>, a: Map<string, number>, b: Map<string, number>, order: string[]) =>
  order.map((id) => `${names.get(id)}: A#${a.get(id)} B#${b.get(id)} worst#${Math.max(a.get(id)!, b.get(id)!)}`);

// Drops the internal rank maps (keyed by entity ID) from the printed summary.
const publicAudit = (a: Audit, names: Map<string, string>) => {
  const { status, poolSize, missing, issues, stable, ranksA, ranksB } = a;
  return { status, poolSize, missing, issues, stable, ranksA, ranksB, order: a.order.map((id) => names.get(id)) };
};

async function runCase(c: Case): Promise<Json> {
  const names = new Map<string, string>();
  const resolveAll = async (inputs: string[], role: string) => {
    const out: Resolved[] = [];
    for (const [i, n] of inputs.entries()) {
      const r = await describe(n, `${c.id}-describe-${role}${i}`, c.confirmed ?? {});
      if (r.id) names.set(r.id, r.name ?? n);
      out.push(r);
    }
    return out;
  };
  const headliner = (await resolveAll([c.headliner], "headliner"))[0];
  const refs = await resolveAll(c.references, "ref");
  const cands = await resolveAll(c.shortlist, "cand");
  const extraRefs = await resolveAll(c.modifiedReferences.filter((n) => !c.references.includes(n)), "modref");
  const resolution = { headliner, refs, cands, extraRefs };
  const unresolved = [headliner, ...refs, ...cands, ...extraRefs].filter((r) => !r.id).map((r) => r.input);
  if (unresolved.length) throw new Error(`${c.id}: unresolved inputs ${unresolved.join(", ")}`);

  const excluded = new Set([headliner.id, ...refs.map((r) => r.id)]);
  const pool = [...new Set(cands.map((r) => r.id!).filter((id) => !excluded.has(id)))];
  const A = [headliner.id!];
  const B = refs.map((r) => r.id!);
  const B2 = [...refs.filter((r) => c.modifiedReferences.includes(r.input)), ...extraRefs].map((r) => r.id!);

  const original = await audit(`${c.id}-orig`, pool, A, B, names, 3);
  // A partial pool is reported as-is; the user-reduced pool is a separately labeled new query.
  const missingIds = pool.filter((id) => !original.rA.has(id) || !original.rB.has(id));
  const reducedPool = pool.filter((id) => !missingIds.includes(id));
  const reduced = original.status === "partial" && reducedPool.length >= 2
    ? await audit(`${c.id}-reduced`, reducedPool, A, B, names, 1)
    : null;
  const working = original.status === "complete" ? original : reduced;
  if (!working || working.status !== "complete") {
    return { id: c.id, resolution, original: publicAudit(original, names), reduced: reduced && publicAudit(reduced, names), stopped: "no complete pool" };
  }
  const workingPool = original.status === "complete" ? pool : reducedPool;

  const top = working.order[0];
  const explainTop = { A: await compare(A, top, `${c.id}-compare-A`), B: await compare(B, top, `${c.id}-compare-B`) };

  // Feedback 1: veto the priority candidate -> original-pool rerank (no new ranking calls).
  const vetoOrder = select(workingPool.filter((id) => id !== top), working.rA, working.rB);
  const vetoTop = vetoOrder[0];
  const explainVeto = vetoTop
    ? { A: await compare(A, vetoTop, `${c.id}-veto-compare-A`), B: await compare(B, vetoTop, `${c.id}-veto-compare-B`) }
    : null;

  // Feedback 2: modified target references -> new query of both sides on the working pool.
  const modified = await audit(`${c.id}-mod`, workingPool, A, B2, names, 1);
  const modTop = modified.order[0];
  const explainMod = modTop ? { B: await compare(B2, modTop, `${c.id}-mod-compare-B`) } : null;

  return {
    id: c.id,
    resolution,
    original: publicAudit(original, names),
    reduced: reduced && publicAudit(reduced, names),
    selection: table(names, working.rA, working.rB, working.order),
    priority: names.get(top),
    explainTop,
    veto: { reason: c.veto, vetoed: names.get(top), newPriority: names.get(vetoTop), order: table(names, working.rA, working.rB, vetoOrder), explainVeto },
    modified: {
      references: c.modifiedReferences,
      ...publicAudit(modified, names),
      sideAUnchanged: sameRanks(modified.rA, working.rA),
      priority: names.get(modTop),
      explainMod,
    },
  };
}

async function main(): Promise<void> {
  if (!process.env.QLOO_API_KEY) throw new Error("QLOO_API_KEY is missing; copy .env.example to .env.local.");
  mkdirSync(runDir, { recursive: true });
  const { cases } = JSON.parse(readFileSync("scripts/t04-cases.json", "utf8")) as { cases: Case[] };
  const only = process.argv[2];
  mcp = new QlooMcp({ paceMs: 0 });
  const results: Json[] = [];
  try {
    for (const c of cases.filter((x) => !only || x.id === only)) {
      results.push(await runCase(c));
      writeFileSync(join(runDir, `${c.id}.json`), JSON.stringify(results.at(-1), null, 2));
    }
  } finally {
    mcp.close();
    const byTool = Object.fromEntries([...new Set(calls.map((c) => c.tool))].map((t) => {
      const xs = calls.filter((c) => c.tool === t).map((c) => c.ms).sort((a, b) => a - b);
      return [t, { n: xs.length, medianMs: xs[Math.floor(xs.length / 2)], maxMs: xs.at(-1) }];
    }));
    const summary = { runDir, toolCalls: calls.length, nonOk: calls.filter((c) => c.status !== "ok"), rateLimitEvents, byTool, results };
    writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
