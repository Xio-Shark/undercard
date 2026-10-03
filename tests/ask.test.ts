// "Ask Undercard" (T19): deterministic parts of the follow-up agent — tool budget, trace labels, score
// stripping and the context the model reads. The model loop itself is covered by the live check in T19.
import { describe, expect, it } from "vitest";
import { askTools, auditContext, MAX_TOOL_CALLS, type TraceItem } from "../lib/ask";
import type { AuditResult, QlooCaller } from "../lib/audit";

type Complete = Extract<AuditResult, { status: "complete" }>;
const L = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";

const side = { sharedTags: [{ tag: "Folk", kind: "genre", score: 0.98 }], onlyGroup: ["Melancholic"], onlyCandidate: ["Dreamy"] };
const result: Complete = {
  status: "complete",
  headliner: { input: "Phoebe Bridgers", id: P, name: "Phoebe Bridgers" },
  references: [{ input: "Olivia Rodrigo", id: "O", name: "Olivia Rodrigo" }],
  pool: [],
  table: [
    { id: L, name: "Lucy Dacus", headlinerRank: 1, targetRank: 3, worstRank: 3 },
    { id: C, name: "Clairo", headlinerRank: 4, targetRank: 2, worstRank: 4 },
  ],
  priority: { id: L, name: "Lucy Dacus", headlinerRank: 1, targetRank: 3, worstRank: 3 },
  priorityTied: false,
  backups: [{ id: C, name: "Clairo", headlinerRank: 4, targetRank: 2, worstRank: 4 }],
  evidence: { headlinerVsPriority: side, targetVsPriority: side },
};
const opts = { toolCallId: "t", messages: [], context: {} };

function fake(): { mcp: QlooCaller; calls: string[] } {
  const calls: string[] = [];
  const mcp: QlooCaller = {
    async call(name, args) {
      calls.push(name);
      if (name === "qloo_describe") return { status: "ok", interpretation: { entity: { entityId: B, name: String(args.entity) } } };
      if (name === "qloo_rank") return { status: "ok", results: [{ entity_id: C, name: "Clairo" }] };
      return { status: "ok", results: { tags: [{ name: "Folk", subtype: "urn:tag:genre", query: { score: 0.9 } }], a: [], b: [] } };
    },
  };
  return { mcp, calls };
}

describe("auditContext", () => {
  it("spells out each act's two ranks in one line and marks the priority", () => {
    const ctx = auditContext({ result, vetoed: [], poolSize: 5 });
    expect(ctx.ranks).toContain("Lucy Dacus: #1 of 5 for Phoebe Bridgers's fans, #3 of 5 for the target audience, weaker side #3 (PRIORITY)");
    expect(ctx.rule).toContain("Priority: Lucy Dacus");
  });

  it("never shows similarity scores to the model", () => {
    expect(JSON.stringify(auditContext({ result, vetoed: [], poolSize: 5 }))).not.toContain("0.98");
  });
});

describe("askTools", () => {
  it("labels ids with artist names in the trace and reports unranked options", async () => {
    const { mcp } = fake();
    const trace: TraceItem[] = [];
    const names = new Map([[L, "Lucy Dacus"], [C, "Clairo"], [P, "Phoebe Bridgers"]]);
    const out = await askTools(mcp, trace, names).rank_for_audience.execute!({ option_ids: [L, C], signal_ids: [P] }, opts);
    expect(out).toMatchObject({ exploratory: true, ranking: [{ rank: 1, name: "Clairo" }], unranked: ["Lucy Dacus"] });
    expect(trace[0].input).toBe("2 acts for fans of Phoebe Bridgers");
  });

  it("strips scores from new comparisons", async () => {
    const out = await askTools(fake().mcp, [], new Map()).compare_audiences.execute!({ group_ids: [P], candidate_id: C }, opts);
    expect(out).toEqual({ sharedTags: ["Folk"], onlyGroup: [], onlyCandidate: [] });
  });

  it(`stops calling Qloo after ${MAX_TOOL_CALLS} tool calls`, async () => {
    const { mcp, calls } = fake();
    const tools = askTools(mcp, [], new Map());
    for (let i = 0; i < MAX_TOOL_CALLS + 2; i++) await tools.lookup_artist.execute!({ name: `A${i}` }, opts);
    expect(calls).toHaveLength(MAX_TOOL_CALLS);
    expect(await tools.lookup_artist.execute!({ name: "late" }, opts)).toHaveProperty("error");
  });

  it("returns a harness error to the model and records it as failed", async () => {
    const mcp: QlooCaller = { call: async () => ({ status: "error", error: { code: "QLOO_BAD_INPUT" } }) };
    const trace: TraceItem[] = [];
    const out = await askTools(mcp, trace, new Map()).lookup_artist.execute!({ name: "x" }, opts);
    expect(out).toEqual({ error: "qloo_describe: QLOO_BAD_INPUT" });
    expect(trace[0].ok).toBe(false);
  });
});
