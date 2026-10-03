// T09 rules: veto = original-pool rerank (no renumbering, explanation re-queried only for a new priority),
// edit = new query with vetoes carried over. Scripted harness, no network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QlooCaller, RankRow } from "../lib/audit";
import { runAudit } from "../lib/audit";
import { applyVetoes, currentResult, runContext, stateFromQuery, vetoRun, VetoError, type Complete, type RunState } from "../lib/replan";
import { decodeShare, encodeShare } from "../lib/share";

const row = (id: string, a: number, b: number): RankRow => ({ id, name: `Act ${id}`, headlinerRank: a, targetRank: b, worstRank: Math.max(a, b) });

/** Compare results name the candidate, so a test can see whose explanation is attached. */
function fakeMcp() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const mcp: QlooCaller = {
    async call(name, args) {
      calls.push({ name, args });
      if (name !== "qloo_compare_audiences") throw new Error(`unexpected tool ${name}`);
      const candidate = (args.group_b as string[])[0];
      return { status: "ok", results: { tags: [{ name: `about ${candidate}`, subtype: "urn:tag:genre:music", query: { score: 0.9 } }], a: [], b: [] } };
    },
  };
  return { mcp, calls };
}

const evidenceFor = (id: string) => ({
  headlinerVsPriority: { sharedTags: [{ tag: `about ${id}`, kind: "genre", score: 0.9 }], onlyGroup: [], onlyCandidate: [] },
  targetVsPriority: { sharedTags: [{ tag: `about ${id}`, kind: "genre", score: 0.9 }], onlyGroup: [], onlyCandidate: [] },
});

function baseState(table: RankRow[]): RunState {
  const result: Complete = {
    status: "complete",
    headliner: { input: "H", id: "H", name: "Headliner" },
    references: [{ input: "R", id: "R", name: "Reference" }],
    pool: table.map((r) => ({ input: r.name, id: r.id, name: r.name })),
    table,
    priority: table[0],
    priorityTied: false,
    backups: table.slice(1, 3),
    evidence: evidenceFor(table[0].id),
  };
  return stateFromQuery({ headliner: "H", references: ["R"], shortlist: table.map((r) => r.name) }, result, "2026-10-03T00:00:00.000Z");
}

// Selection order by key (worst, sum): B (2,3), A (3,4), C (3,5), D (4,8). No ties.
const T = [row("B", 2, 1), row("A", 1, 3), row("C", 3, 2), row("D", 4, 4)];
const now = () => new Date("2026-10-03T01:00:00.000Z");

describe("applyVetoes", () => {
  it("keeps original ranks and order, never renumbers", () => {
    const left = applyVetoes(T, new Set(["B"]));
    expect(left.map((r) => r.id)).toEqual(["A", "C", "D"]);
    expect(left[0]).toMatchObject({ headlinerRank: 1, targetRank: 3, worstRank: 3 });
  });

  it("re-flags ties for rows that become neighbours", () => {
    const tied = [row("X", 1, 2), row("Y", 3, 3), row("Z", 2, 1)]; // X and Z share key (2, 3) but Y sits between in this table
    expect(applyVetoes(tied, new Set(["Y"]))[1].tiedWithPrevious).toBe(true);
    const flagged = [row("X", 1, 2), { ...row("Z", 2, 1), tiedWithPrevious: true }, row("Y", 3, 3)];
    expect(applyVetoes(flagged, new Set(["X"]))[0].tiedWithPrevious).toBeUndefined();
  });
});

describe("vetoRun", () => {
  it("vetoing the priority re-queries the explanation for the new priority only", async () => {
    const { mcp, calls } = fakeMcp();
    const next = await vetoRun(mcp, baseState(T), { id: "B", reason: "fee" }, { now });
    expect(calls.map((c) => c.name)).toEqual(["qloo_compare_audiences", "qloo_compare_audiences"]);
    expect(calls.every((c) => (c.args.group_b as string[])[0] === "A")).toBe(true);
    const current = currentResult(next)!;
    expect(current.priority.id).toBe("A");
    expect(current.evidence.headlinerVsPriority.sharedTags[0].tag).toBe("about A");
    expect(next.explanation).toMatchObject({ forId: "A", refetched: true, at: "2026-10-03T01:00:00.000Z" });
    expect(next.change).toMatchObject({ kind: "veto", priorityBefore: "Act B", priorityAfter: "Act A", trigger: "Vetoed Act B (fee)" });
    const ctx = runContext(next);
    expect(ctx).toMatchObject({ label: "rerank", originalPoolSize: 4 });
    expect(ctx.vetoed[0]).toMatchObject({ id: "B", headlinerRank: 2, targetRank: 1, beforeQuery: false });
  });

  it("vetoing a backup makes no Qloo call and keeps the explanation's original time", async () => {
    const { mcp, calls } = fakeMcp();
    const next = await vetoRun(mcp, baseState(T), { id: "C", reason: "dates", note: "touring EU" }, { now });
    expect(calls).toHaveLength(0);
    expect(next.explanation).toMatchObject({ forId: "B", refetched: false, at: "2026-10-03T00:00:00.000Z" });
    expect(currentResult(next)!.backups.map((b) => b.id)).toEqual(["A", "D"]);
    expect(next.change?.trigger).toBe("Vetoed Act C (dates: touring EU)");
  });

  it("vetoes down to one candidate, then to an empty pool that stops without undoing", async () => {
    const { mcp } = fakeMcp();
    let s = baseState(T.slice(0, 2));
    s = await vetoRun(mcp, s, { id: "B", reason: "other" }, { now });
    expect(currentResult(s)!.table.map((r) => r.id)).toEqual(["A"]);
    expect(runContext(s).originalPoolSize).toBe(2);
    s = await vetoRun(mcp, s, { id: "A", reason: "toured_together" }, { now });
    expect(currentResult(s)).toBeNull();
    expect(s.explanation).toBeNull();
    expect(s.vetoes.map((v) => v.id)).toEqual(["B", "A"]);
    expect(s.change).toMatchObject({ priorityBefore: "Act A", priorityAfter: null });
    await expect(vetoRun(mcp, s, { id: "A", reason: "fee" })).rejects.toThrow(VetoError);
  });

  it("rejects vetoing an act that was already vetoed or never in the pool", async () => {
    const { mcp } = fakeMcp();
    const s = await vetoRun(mcp, baseState(T), { id: "D", reason: "fee" }, { now });
    await expect(vetoRun(mcp, s, { id: "D", reason: "fee" })).rejects.toThrow(VetoError);
    await expect(vetoRun(mcp, s, { id: "nobody", reason: "fee" })).rejects.toThrow(VetoError);
  });

  it("refuses to show an explanation that belongs to another act", () => {
    const s = baseState(T);
    expect(() => currentResult({ ...s, vetoes: [{ id: "B", name: "Act B", reason: "fee", at: "x" }] })).toThrow(/Explanation belongs to B/);
  });
});

describe("new query after editing references", () => {
  it("excludes vetoed ids before ranking and labels the change as a new query", async () => {
    const calls: string[] = [];
    const ids: Record<string, string> = { Head: "H", Ref2: "R2", "Act A": "A", "Act B": "B", "Act C": "C" };
    const mcp: QlooCaller = {
      async call(name, args) {
        calls.push(name);
        if (name === "qloo_describe") return { status: "ok", interpretation: { entity: { entityId: ids[String(args.entity)], name: String(args.entity) } } };
        if (name === "qloo_rank") return { status: "ok", results: (args.options as string[]).map((id) => ({ entity_id: id })) };
        return { status: "ok", results: { tags: [], a: [], b: [] } };
      },
    };
    const previous = await vetoRun(fakeMcp().mcp, baseState(T), { id: "B", reason: "fee" }, { now });
    const input = { headliner: "Head", references: ["Ref2"], shortlist: ["Act A", "Act B", "Act C"] };
    const result = await runAudit(mcp, { ...input, vetoedIds: previous.vetoes.map((v) => v.id) });
    expect(result.status).toBe("complete");
    const done = result as Complete;
    expect(done.pool.map((p) => p.id)).toEqual(["A", "C"]);
    const next = stateFromQuery(input, done, "2026-10-03T02:00:00.000Z", previous);
    expect(next.change).toMatchObject({ kind: "new_query", priorityBefore: "Act A", priorityAfter: "Act A" });
    expect(next.change?.trigger).toContain("Target references: R → Ref2");
    const ctx = runContext(next);
    expect(ctx.label).toBe("query");
    expect(ctx.vetoed[0]).toMatchObject({ id: "B", beforeQuery: true });
  });
});

describe("state tokens", () => {
  beforeEach(() => {
    process.env.SHARE_SECRET = "test-secret-test-secret-test-secret-123";
  });
  afterEach(() => {
    delete process.env.SHARE_SECRET;
  });

  it("a share token cannot be used as a run state, and vice versa", () => {
    const state = baseState(T);
    expect(decodeShare(encodeShare(state, "s1"), "s1")).toEqual(state);
    expect(() => decodeShare(encodeShare(state, "v1"), "s1")).toThrow();
    expect(() => decodeShare(encodeShare(state, "s1"))).toThrow();
  });
});

describe("harness notes (degraded results are surfaced, not silent)", () => {
  it("a re-queried explanation replaces the old explanation notes; ranking notes stay", async () => {
    const calls: string[] = [];
    const degraded: QlooCaller = {
      async call(name, args) {
        calls.push(name);
        const candidate = (args.group_b as string[])[0];
        return { status: "degraded", summary: "one upstream unavailable", warnings: [`tags partial for ${candidate}`], results: { tags: [], a: [], b: [] } };
      },
    };
    const base = baseState(T);
    const s0: RunState = {
      ...base,
      ranked: { ...base.ranked, qlooNotes: { ranking: ["qloo_rank: partial"], explanation: [] } },
      explanation: { ...base.explanation!, notes: ["qloo_compare_audiences: old note for B"] },
    };
    expect(currentResult(s0)!.qlooNotes).toEqual({ ranking: ["qloo_rank: partial"], explanation: ["qloo_compare_audiences: old note for B"] });
    const s1 = await vetoRun(degraded, s0, { id: "B", reason: "fee" }, { now });
    const notes = currentResult(s1)!.qlooNotes!;
    expect(notes.ranking).toEqual(["qloo_rank: partial"]);
    expect(notes.explanation).toEqual([
      "qloo_compare_audiences: degraded — one upstream unavailable",
      "qloo_compare_audiences: tags partial for A",
      "qloo_compare_audiences: degraded — one upstream unavailable",
      "qloo_compare_audiences: tags partial for A",
    ]);
  });
});
