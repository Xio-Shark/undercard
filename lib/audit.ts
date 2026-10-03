// Server-owned audit pipeline: resolve -> confirm pool -> rank both sides -> coverage -> selection -> evidence.
// The model never touches ordering or pool membership; it only writes the brief from what this returns.
import { checkCoverage, isTie, selectionOrder } from "./selection";
import type { Envelope, QlooMcp } from "./qloo-mcp";

/** The only capability the pipeline needs; tests inject a scripted fake. */
export type QlooCaller = Pick<QlooMcp, "call">;

export interface AuditInput {
  headliner: string;
  references: string[]; // 1-3 target-audience proxies
  shortlist: string[]; // 2-10 pre-screened candidates
  /** User-confirmed choices for ambiguous names: input text -> Qloo entity id. */
  confirmations?: Record<string, string>;
  /** Entity ids the team vetoed earlier; they are removed from the pool before ranking. */
  vetoedIds?: string[];
}

export interface Entity { input: string; id: string; name: string }
export interface Choice { id: string; name: string; description?: string }
export interface RankRow {
  id: string;
  name: string;
  headlinerRank: number;
  targetRank: number;
  worstRank: number;
  /** Same selection key as the row above: the order between them is display-only (stable id). */
  tiedWithPrevious?: boolean;
}
export interface SideComparison {
  sharedTags: { tag: string; kind: string; score: number }[];
  onlyGroup: string[];
  onlyCandidate: string[];
}

export type AuditResult =
  | { status: "needs_input"; ambiguous: { input: string; role: string; choices: Choice[] }[] }
  | { status: "invalid_pool"; reason: string; excluded: string[] }
  | { status: "partial"; poolSize: number; missing: string[]; /** The user's own spellings, for removing them from the list. */ missingInputs: string[]; ranked: RankRow[] }
  | {
      status: "complete";
      headliner: Entity;
      references: Entity[];
      pool: Entity[];
      table: RankRow[]; // in selection order
      priority: RankRow;
      /** True when the first two rows tie exactly, so the rule does not single out one priority. */
      priorityTied: boolean;
      backups: RankRow[];
      evidence: Evidence;
      /** Absent in runs saved before T13. */
      qlooNotes?: QlooNotes;
    };

export type Evidence = { headlinerVsPriority: SideComparison; targetVsPriority: SideComparison };
/** What the harness flagged (non-ok statuses, warnings), kept apart by stage so a re-queried explanation replaces its own notes. */
export type QlooNotes = { ranking: string[]; explanation: string[] };

export type Progress = (step: string, detail?: string) => void;

export class QlooToolError extends Error {}

async function tool(mcp: QlooCaller, name: string, args: Envelope, signal?: AbortSignal): Promise<Envelope> {
  const out = await mcp.call(name, args, signal);
  if (out.status === undefined || out.status === "error") {
    const err = out.error as { code?: string; retryable?: boolean } | undefined;
    throw new QlooToolError(`${name} failed: ${err?.code ?? "unknown"}${err?.retryable ? " (retryable)" : ""}`);
  }
  return out;
}

/** Waits for Qloo's per-second limit to clear before retrying; delays grow per attempt. */
export const RATE_LIMIT_RETRY_MS = [2_000, 5_000];

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

/**
 * Wraps a caller so nothing passes silently:
 * - degraded/partial/empty results and harness warnings are recorded in `notes`;
 * - QLOO_RATE_LIMIT (marked retryable by the harness) is retried after RATE_LIMIT_RETRY_MS, each retry noted.
 *   Cause: qloo_rank fans out one lookup per entity, so a cold 10-act pool bursts past 5 req/s (T04, T16).
 *   After the last retry the error is returned unchanged and the audit fails visibly.
 */
export function noting(mcp: QlooCaller, notes: string[], retryMs: readonly number[] = RATE_LIMIT_RETRY_MS): QlooCaller {
  return {
    async call(name, args, signal) {
      for (let attempt = 0; ; attempt++) {
        const out = await mcp.call(name, args, signal);
        const err = out.error as { code?: string; retryable?: boolean } | undefined;
        if (out.status === "error" && err?.code === "QLOO_RATE_LIMIT" && err.retryable && attempt < retryMs.length) {
          notes.push(`${name}: rate-limited by Qloo, retried after ${retryMs[attempt] / 1000} s`);
          await pause(retryMs[attempt], signal);
          continue;
        }
        const status = String(out.status);
        if (status !== "ok" && status !== "needs_input" && status !== "error") notes.push(`${name}: ${status}${out.summary ? ` — ${String(out.summary)}` : ""}`);
        for (const w of (out.warnings as string[] | undefined) ?? []) notes.push(`${name}: ${w}`);
        return out;
      }
    },
  };
}

async function resolveAll(mcp: QlooCaller, inputs: { text: string; role: string }[], confirmations: Record<string, string>, signal?: AbortSignal) {
  const resolved: (Entity & { role: string })[] = [];
  const ambiguous: { input: string; role: string; choices: Choice[] }[] = [];
  for (const { text, role } of inputs) {
    const entity = confirmations[text] ?? text;
    const out = await tool(mcp, "qloo_describe", { entity, type: "artist" }, signal);
    if (out.status === "needs_input") {
      const issue = ((out.resolution as Envelope)?.issues as Envelope[] | undefined)?.[0];
      const choices = ((issue?.candidates as Envelope[]) ?? []).map((c) => ({
        id: String(c.id),
        name: String(c.name),
        description: c.description as string | undefined,
      }));
      ambiguous.push({ input: text, role, choices });
      continue;
    }
    const e = (out.interpretation as { entity?: { entityId?: string; name?: string } })?.entity;
    if (out.status !== "ok" || !e?.entityId) throw new QlooToolError(`qloo_describe "${text}" returned ${out.status}`);
    resolved.push({ input: text, role, id: e.entityId, name: e.name ?? text });
  }
  return { resolved, ambiguous };
}

async function rankSide(mcp: QlooCaller, pool: string[], signals: string[], signal?: AbortSignal): Promise<Map<string, number>> {
  const out = await tool(mcp, "qloo_rank", { options: pool, option_type: "artist", signals }, signal);
  const ids = ((out.results as Envelope[]) ?? []).map((r) => String(r.entity_id));
  // Coverage is checked by the caller; out-of-pool ids or duplicates mean the contract is broken.
  if (ids.some((id) => !pool.includes(id)) || new Set(ids).size !== ids.length) {
    throw new QlooToolError("qloo_rank returned ids outside the pool or duplicates");
  }
  return new Map(ids.map((id, i) => [id, i + 1]));
}

/** Trims compare_audiences (~49 KB raw) to citable tags; duplicates by name are merged. */
export async function compare(mcp: QlooCaller, group: string[], candidate: string, signal?: AbortSignal): Promise<SideComparison> {
  const out = await tool(mcp, "qloo_compare_audiences", { group_a: group, group_b: [candidate], target_type: "artist" }, signal);
  const r = (out.results ?? {}) as { tags?: Envelope[]; a?: Envelope[]; b?: Envelope[] };
  const kind = (t: Envelope) => String(t.subtype ?? "").split(":")[2] ?? "tag";
  const seen = new Set<string>();
  const sharedTags = (r.tags ?? [])
    .filter((t) => !seen.has(String(t.name)) && seen.add(String(t.name)))
    .slice(0, 10)
    .map((t) => ({ tag: String(t.name), kind: kind(t), score: Number(Number((t.query as Envelope)?.score ?? 0).toFixed(2)) }));
  const names = (xs?: Envelope[]) => new Set((xs ?? []).map((t) => String(t.name)));
  const [a, b] = [names(r.a), names(r.b)];
  return {
    sharedTags,
    onlyGroup: [...a].filter((n) => !b.has(n)).slice(0, 8),
    onlyCandidate: [...b].filter((n) => !a.has(n)).slice(0, 8),
  };
}

/** Two-side explanation for one candidate: headliner vs candidate, target references vs candidate. */
export async function explainSides(mcp: QlooCaller, sides: { headlinerId: string; referenceIds: string[]; candidateId: string }, signal?: AbortSignal): Promise<Evidence> {
  return {
    headlinerVsPriority: await compare(mcp, [sides.headlinerId], sides.candidateId, signal),
    targetVsPriority: await compare(mcp, sides.referenceIds, sides.candidateId, signal),
  };
}

export async function runAudit(mcp: QlooCaller, input: AuditInput, opts: { onProgress?: Progress; signal?: AbortSignal } = {}): Promise<AuditResult> {
  const { onProgress = () => {}, signal } = opts;
  const notes: QlooNotes = { ranking: [], explanation: [] };
  const raw = mcp;
  mcp = noting(raw, notes.ranking);
  onProgress("resolve", `${1 + input.references.length + input.shortlist.length} names`);
  const { resolved, ambiguous } = await resolveAll(
    mcp,
    [
      { text: input.headliner, role: "headliner" },
      ...input.references.map((text) => ({ text, role: "reference" })),
      ...input.shortlist.map((text) => ({ text, role: "candidate" })),
    ],
    input.confirmations ?? {},
    signal,
  );
  if (ambiguous.length) return { status: "needs_input", ambiguous };

  const headliner = resolved.find((e) => e.role === "headliner")!;
  const references = resolved.filter((e) => e.role === "reference");
  const excludedIds = new Set([headliner.id, ...references.map((r) => r.id), ...(input.vetoedIds ?? [])]);
  const seen = new Set<string>();
  const excluded: string[] = [];
  const pool = resolved.filter((e) => {
    if (e.role !== "candidate") return false;
    if (excludedIds.has(e.id) || seen.has(e.id)) return excluded.push(e.input), false;
    return seen.add(e.id), true;
  });
  if (pool.length < 2) return { status: "invalid_pool", reason: "A new audit needs at least 2 distinct candidates.", excluded };

  const ids = pool.map((e) => e.id);
  const name = new Map(pool.map((e) => [e.id, e.name]));
  onProgress("rank", "headliner side");
  const rA = await rankSide(mcp, ids, [headliner.id], signal);
  onProgress("rank", "target side");
  const rB = await rankSide(mcp, ids, references.map((r) => r.id), signal);
  const row = (id: string): RankRow => ({
    id,
    name: name.get(id)!,
    headlinerRank: rA.get(id) ?? NaN,
    targetRank: rB.get(id) ?? NaN,
    worstRank: Math.max(rA.get(id) ?? NaN, rB.get(id) ?? NaN),
  });

  const coverage = checkCoverage(ids, rA, rB);
  if (!coverage.complete) {
    const input = new Map(pool.map((e) => [e.id, e.input]));
    return {
      status: "partial",
      poolSize: ids.length,
      missing: coverage.missing.map((id) => name.get(id)!),
      missingInputs: coverage.missing.map((id) => input.get(id)!),
      ranked: ids.filter((id) => !coverage.missing.includes(id)).map(row),
    };
  }
  const ordered = selectionOrder(ids, rA, rB);
  const table = ordered.map((id, i) => (i > 0 && isTie(ordered[i - 1], id, rA, rB) ? { ...row(id), tiedWithPrevious: true } : row(id)));
  const priority = table[0];
  onProgress("compare", priority.name);
  const evidence = await explainSides(noting(raw, notes.explanation), { headlinerId: headliner.id, referenceIds: references.map((r) => r.id), candidateId: priority.id }, signal);
  const strip = (e: Entity & { role: string }): Entity => ({ input: e.input, id: e.id, name: e.name });
  const priorityTied = table.length > 1 && table[1].tiedWithPrevious === true;
  return { status: "complete", headliner: strip(headliner), references: references.map(strip), pool: pool.map(strip), table, priority, priorityTied, backups: table.slice(1, 3), evidence, qlooNotes: notes };
}
