// Veto and re-plan (technical-design.md "否决与重规划"). Server-owned: the run state travels to the
// browser only as a signed token (lib/share.ts kind "s1"), so ranks, vetoes and explanation ownership
// cannot be edited client-side.
//   veto            -> original-pool rerank: same ranks, no renumbering; the explanation is re-queried
//                      only when the priority changes, and always belongs to the current priority.
//   edit references -> new query (handled by runAudit with vetoedIds); vetoes carry over.
import { explainSides, noting, type AuditInput, type AuditResult, type Evidence, type QlooCaller, type RankRow } from "./audit";
import { sameKey } from "./selection";

export type Complete = Extract<AuditResult, { status: "complete" }>;
export type Ranked = Omit<Complete, "evidence">;

export const VETO_REASONS = ["fee", "dates", "toured_together", "other"] as const;
export type VetoReason = (typeof VETO_REASONS)[number];
export const VETO_LABEL: Record<VetoReason, string> = { fee: "fee", dates: "dates", toured_together: "toured together", other: "other" };

export interface Veto { id: string; name: string; reason: VetoReason; note?: string; at: string }
export interface Explanation { forId: string; at: string; /** true when fetched after a veto rather than with the ranks */ refetched: boolean; evidence: Evidence; /** Harness notes for these compare calls. */ notes?: string[] }
export interface Change { kind: "veto" | "new_query"; trigger: string; priorityBefore: string | null; priorityAfter: string | null; at: string }

export interface RunState {
  input: AuditInput & { question?: string; language?: "English" | "Chinese" };
  /** The last real Qloo query; vetoes never change these ranks. */
  ranked: Ranked;
  rankedAt: string;
  vetoes: Veto[];
  /** null only when every candidate is vetoed. */
  explanation: Explanation | null;
  change?: Change;
}

/** What the page shows next to the result; derived from RunState, never sent back. */
export interface RunContext {
  label: "query" | "rerank";
  originalPoolSize: number;
  rankedAt: string;
  vetoed: (RankRow & { reason: VetoReason; note?: string; at: string; beforeQuery: boolean })[];
  explanation: { at: string; refetched: boolean } | null;
  change?: Change;
}

/** Removes vetoed rows from the selection order. Ranks keep their original numbers; ties are re-flagged for new neighbours. */
export function applyVetoes(table: readonly RankRow[], vetoedIds: ReadonlySet<string>): RankRow[] {
  const kept = table.filter((r) => !vetoedIds.has(r.id));
  return kept.map((r, i) => {
    const row: RankRow = { ...r };
    delete row.tiedWithPrevious;
    const prev = kept[i - 1];
    return prev && sameKey([prev.headlinerRank, prev.targetRank], [r.headlinerRank, r.targetRank]) ? { ...row, tiedWithPrevious: true } : row;
  });
}

/** The current view as a complete result, or null when the pool is empty. Throws if the explanation belongs to someone else. */
export function currentResult(state: RunState): Complete | null {
  const table = applyVetoes(state.ranked.table, new Set(state.vetoes.map((v) => v.id)));
  if (table.length === 0) return null;
  const priority = table[0];
  if (state.explanation?.forId !== priority.id) throw new Error(`Explanation belongs to ${state.explanation?.forId ?? "nobody"}, not the priority ${priority.id}`);
  const qlooNotes = { ranking: state.ranked.qlooNotes?.ranking ?? [], explanation: state.explanation.notes ?? [] };
  return { ...state.ranked, table, priority, priorityTied: table[1]?.tiedWithPrevious === true, backups: table.slice(1, 3), evidence: state.explanation.evidence, qlooNotes };
}

export function runContext(state: RunState): RunContext {
  const rows = new Map(state.ranked.table.map((r) => [r.id, r]));
  return {
    label: state.vetoes.some((v) => rows.has(v.id)) ? "rerank" : "query",
    originalPoolSize: state.ranked.table.length,
    rankedAt: state.rankedAt,
    vetoed: state.vetoes.map((v) => {
      const row = rows.get(v.id);
      // A veto carried into a new query was removed before ranking, so it has no rank in this pool.
      return { ...(row ?? { id: v.id, name: v.name, headlinerRank: NaN, targetRank: NaN, worstRank: NaN }), reason: v.reason, note: v.note, at: v.at, beforeQuery: !row };
    }),
    explanation: state.explanation && { at: state.explanation.at, refetched: state.explanation.refetched },
    change: state.change,
  };
}

export class VetoError extends Error {}

/** Applies one veto. Calls Qloo only when the priority changes (two compare_audiences). */
export async function vetoRun(
  mcp: QlooCaller,
  state: RunState,
  veto: { id: string; reason: VetoReason; note?: string },
  opts: { signal?: AbortSignal; now?: () => Date; onProgress?: (step: string, detail?: string) => void } = {},
): Promise<RunState> {
  const now = () => (opts.now?.() ?? new Date()).toISOString();
  const before = currentResult(state);
  const row = before?.table.find((r) => r.id === veto.id);
  if (!before || !row) throw new VetoError("That act is not in the current pool (already vetoed or never ranked).");
  const next: RunState = { ...state, vetoes: [...state.vetoes, { ...veto, name: row.name, at: now() }] };
  const remaining = applyVetoes(state.ranked.table, new Set(next.vetoes.map((v) => v.id)));
  const priority = remaining[0];
  let explanation = state.explanation;
  if (!priority) explanation = null;
  else if (priority.id !== before.priority.id) {
    opts.onProgress?.("compare", priority.name);
    const notes: string[] = [];
    const evidence = await explainSides(noting(mcp, notes), { headlinerId: state.ranked.headliner.id, referenceIds: state.ranked.references.map((r) => r.id), candidateId: priority.id }, opts.signal);
    explanation = { forId: priority.id, at: now(), refetched: true, evidence, notes };
  }
  const trigger = `Vetoed ${row.name} (${VETO_LABEL[veto.reason]}${veto.note ? `: ${veto.note}` : ""})`;
  return { ...next, explanation, change: { kind: "veto", trigger, priorityBefore: before.priority.name, priorityAfter: priority?.name ?? null, at: now() } };
}

/** State for a fresh query; `previous` carries vetoes and yields the change summary. */
export function stateFromQuery(input: RunState["input"], result: Complete, at: string, previous?: RunState): RunState {
  const { evidence, qlooNotes, ...rest } = result;
  // Ranking notes stay with the ranks; explanation notes move with the explanation (replaced on re-query).
  const ranked: Ranked = { ...rest, qlooNotes: { ranking: qlooNotes?.ranking ?? [], explanation: [] } };
  const explanation: Explanation = { forId: result.priority.id, at, refetched: false, evidence, notes: qlooNotes?.explanation ?? [] };
  const state: RunState = { input, ranked, rankedAt: at, vetoes: previous?.vetoes ?? [], explanation };
  if (!previous) return state;
  return { ...state, change: { kind: "new_query", trigger: describeEdit(previous.input, input), priorityBefore: currentPriorityName(previous), priorityAfter: result.priority.name, at } };
}

function currentPriorityName(state: RunState): string | null {
  return applyVetoes(state.ranked.table, new Set(state.vetoes.map((v) => v.id)))[0]?.name ?? null;
}

function describeEdit(a: RunState["input"], b: RunState["input"]): string {
  const parts: string[] = [];
  const same = (x: string[], y: string[]) => x.join("\n") === y.join("\n");
  if (!same(a.references, b.references)) parts.push(`Target references: ${a.references.join(", ")} → ${b.references.join(", ")}`);
  if (!same(a.shortlist, b.shortlist)) parts.push("Shortlist edited");
  if (a.headliner !== b.headliner) parts.push(`Headliner: ${a.headliner} → ${b.headliner}`);
  return parts.join("; ") || "Same inputs re-queried";
}

/** Case text and evidence for the brief writer. Ranks stay those of the original pool after vetoes. */
/** The case as the model reads it. Single builder for the product and the with/without-Qloo comparison (T10). */
export function caseText(c: { headliner: string; references: string[]; inPlay: string[]; vetoed: { name: string; reason: VetoReason }[]; question?: string }): string {
  return [
    `Headliner: ${c.headliner}.`,
    `Target audience reference artists: ${c.references.join(", ")}.`,
    `Shortlist still in play (pre-screened by the team): ${c.inPlay.join(", ")}.`,
    c.vetoed.length ? `Vetoed by the team, do not discuss their fit: ${c.vetoed.map((v) => `${v.name} (${VETO_LABEL[v.reason]})`).join(", ")}.` : "",
    c.question ? `Team question: ${c.question}` : "",
  ].filter(Boolean).join("\n");
}

/** Acts still in play, in the order the team entered them. */
export function inPlayNames(current: Complete): string[] {
  const live = new Set(current.table.map((r) => r.id));
  return current.pool.filter((p) => live.has(p.id)).map((p) => p.name);
}

export function briefInput(state: RunState, current: Complete) {
  const ctx = runContext(state);
  const text = caseText({
    headliner: current.headliner.name,
    references: current.references.map((r) => r.name),
    // Input order, not rank order: the case text must not leak Qloo's ordering (the same text feeds the T10 baseline).
    inPlay: inPlayNames(current),
    vetoed: ctx.vetoed,
    question: state.input.question,
  });
  const evidence = {
    table: current.table,
    rankNote: ctx.label === "rerank"
      ? `Ranks are positions in the original pool of ${ctx.originalPoolSize}; vetoed acts were removed without re-ranking or renumbering.`
      : `Ranks are positions in this pool of ${ctx.originalPoolSize}.`,
    onlyOneCandidateLeft: current.table.length === 1,
    priority: current.priority.name,
    priorityTiedWithNext: current.priorityTied,
    backups: current.backups.map((b) => b.name),
    audienceComparison: current.evidence,
    // Non-ok harness results (degraded, partial, empty) and warnings; the brief must mention them as limits.
    qlooNotes: [...(current.qlooNotes?.ranking ?? []), ...(current.qlooNotes?.explanation ?? [])],
  };
  return { caseText: text, evidence };
}
