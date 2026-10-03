// Contract tests for the server-owned audit pipeline against a scripted harness (no network).
// Envelope shapes mirror real `qloo mcp` responses recorded in T04 (see Task/evidence/T04-qloo-probe.md).
import { describe, expect, it } from "vitest";
import { runAudit, QlooToolError, type QlooCaller } from "../lib/audit";
import { isTie } from "../lib/selection";

type Envelope = Record<string, unknown>;
const ID: Record<string, string> = {
  "Phoebe Bridgers": "P", "Olivia Rodrigo": "O", "Lucy Dacus": "L", Clairo: "C", "Gracie Abrams": "G", "Julien Baker": "J",
};

function describeOk(name: string): Envelope {
  return { status: "ok", interpretation: { entity: { entityId: ID[name] ?? name, name } } };
}

/** Builds a fake harness: describe resolves via ID, rank follows `order[signal]`, compare returns fixed tags. */
function fakeHarness(opts: {
  order: Record<string, string[]>;
  ambiguous?: string[];
  rankOverride?: (pool: string[], signals: string[]) => Envelope | undefined;
}) {
  const calls: { name: string; args: Envelope }[] = [];
  const mcp: QlooCaller = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === "qloo_describe") {
        const entity = String(args.entity);
        if (opts.ambiguous?.includes(entity)) {
          return { status: "needs_input", resolution: { issues: [{ input: entity, candidates: [{ id: "X1", name: `${entity} (band)` }, { id: "X2", name: `${entity} (film)` }] }] } };
        }
        return describeOk(Object.keys(ID).find((k) => ID[k] === entity) ?? entity);
      }
      if (name === "qloo_rank") {
        const pool = args.options as string[];
        const signals = args.signals as string[];
        const override = opts.rankOverride?.(pool, signals);
        if (override) return override;
        const order = opts.order[signals.join("+")].filter((id) => pool.includes(id));
        return { status: "ok", results: order.map((id) => ({ entity_id: id })) };
      }
      if (name === "qloo_compare_audiences") {
        return {
          status: "ok",
          results: {
            tags: [
              { name: "Folk", subtype: "urn:tag:genre:music", query: { score: 0.98 } },
              { name: "Post Punk", subtype: "urn:tag:genre:music", query: { score: 0.73 } },
              { name: "Post Punk", subtype: "urn:tag:genre:qloo", query: { score: 0.73 } },
            ],
            a: [{ name: "Heartbreak" }, { name: "Folk" }],
            b: [{ name: "Dreamy" }, { name: "Folk" }],
          },
        };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  return { mcp, calls };
}

// D1 ranks recorded in T04: A = headliner side, B = target side.
const D1_ORDER = { P: ["L", "J", "S", "C", "G"], O: ["G", "C", "L", "S", "J"] };
const D1_INPUT = { headliner: "Phoebe Bridgers", references: ["Olivia Rodrigo"], shortlist: ["Lucy Dacus", "Clairo", "Gracie Abrams"] };

describe("runAudit", () => {
  it("selects by worst side rank and attaches both comparisons", async () => {
    const { mcp, calls } = fakeHarness({ order: D1_ORDER });
    const r = await runAudit(mcp, D1_INPUT);
    expect(r.status).toBe("complete");
    if (r.status !== "complete") return;
    // In the 3-person pool: L = A1/B3, C = A2/B2, G = A3/B1 -> Clairo has the best worst rank.
    // L and G tie exactly (worst 3, sum 4); the stable id only orders them for display ("G" < "L").
    expect(r.table.map((x) => [x.name, x.headlinerRank, x.targetRank])).toEqual([
      ["Clairo", 2, 2],
      ["Gracie Abrams", 3, 1],
      ["Lucy Dacus", 1, 3],
    ]);
    const a = new Map(r.table.map((x) => [x.id, x.headlinerRank]));
    const b = new Map(r.table.map((x) => [x.id, x.targetRank]));
    expect(isTie("G", "L", a, b)).toBe(true);
    expect(r.table.map((x) => !!x.tiedWithPrevious)).toEqual([false, false, true]);
    expect(r.priority.name).toBe("Clairo");
    expect(r.priorityTied).toBe(false);
    // Duplicate tag names across tag types are merged.
    expect(r.evidence.headlinerVsPriority.sharedTags.map((t) => t.tag)).toEqual(["Folk", "Post Punk"]);
    expect(r.evidence.headlinerVsPriority.onlyGroup).toEqual(["Heartbreak"]);
    // Ranking uses resolved ids for both the pool and the signals.
    const ranks = calls.filter((c) => c.name === "qloo_rank");
    expect(ranks.map((c) => c.args.signals)).toEqual([["P"], ["O"]]);
    expect(ranks[0].args.options).toEqual(["L", "C", "G"]);
  });

  it("flags a tie at the top instead of presenting an id-ordered pick as the rule's choice", async () => {
    const { mcp } = fakeHarness({ order: { P: ["L", "G"], O: ["G", "L"] } });
    const r = await runAudit(mcp, { ...D1_INPUT, shortlist: ["Lucy Dacus", "Gracie Abrams"] });
    expect(r.status === "complete" && r.priorityTied).toBe(true);
  });

  it("returns needs_input with choices instead of guessing", async () => {
    const { mcp, calls } = fakeHarness({ order: D1_ORDER, ambiguous: ["Clairo"] });
    const r = await runAudit(mcp, D1_INPUT);
    expect(r).toEqual({ status: "needs_input", ambiguous: [{ input: "Clairo", role: "candidate", choices: [{ id: "X1", name: "Clairo (band)" }, { id: "X2", name: "Clairo (film)" }] }] });
    expect(calls.some((c) => c.name === "qloo_rank")).toBe(false);
  });

  it("uses a user confirmation for an ambiguous name", async () => {
    const { mcp, calls } = fakeHarness({ order: D1_ORDER, ambiguous: ["Clairo"] });
    const r = await runAudit(mcp, { ...D1_INPUT, confirmations: { Clairo: "C" } });
    expect(r.status).toBe("complete");
    expect(calls.find((c) => c.name === "qloo_describe" && c.args.entity === "C")).toBeDefined();
  });

  it("reports partial coverage and never picks a priority", async () => {
    const { mcp } = fakeHarness({ order: { P: ["L", "C"], O: ["G", "C", "L"] } });
    const r = await runAudit(mcp, D1_INPUT);
    expect(r.status).toBe("partial");
    if (r.status !== "partial") return;
    expect(r.missing).toEqual(["Gracie Abrams"]);
    expect(r.missingInputs).toEqual(["Gracie Abrams"]);
    expect(r.ranked.map((x) => x.name)).toEqual(["Lucy Dacus", "Clairo"]);
  });

  it("drops duplicates and the headliner/references from the pool, then requires 2 candidates", async () => {
    const { mcp } = fakeHarness({ order: D1_ORDER });
    const r = await runAudit(mcp, { headliner: "Phoebe Bridgers", references: ["Olivia Rodrigo"], shortlist: ["Lucy Dacus", "Lucy Dacus", "Olivia Rodrigo"] });
    expect(r).toEqual({ status: "invalid_pool", reason: "A new audit needs at least 2 distinct candidates.", excluded: ["Lucy Dacus", "Olivia Rodrigo"] });
  });

  it("fails loudly when rank returns ids outside the pool", async () => {
    const { mcp } = fakeHarness({ order: D1_ORDER, rankOverride: () => ({ status: "ok", results: [{ entity_id: "L" }, { entity_id: "ZZZ" }] }) });
    await expect(runAudit(mcp, D1_INPUT)).rejects.toBeInstanceOf(QlooToolError);
  });

  it("surfaces harness errors with their code instead of continuing", async () => {
    // Non-retryable code: rate-limit retries are covered in "Qloo rate limit" below.
    const { mcp } = fakeHarness({ order: D1_ORDER, rankOverride: () => ({ status: "error", error: { code: "QLOO_UPSTREAM_TIMEOUT", retryable: false } }) });
    await expect(runAudit(mcp, D1_INPUT)).rejects.toThrow(/qloo_rank failed: QLOO_UPSTREAM_TIMEOUT$/);
  });

  it("stops before further tool calls once aborted", async () => {
    const { mcp, calls } = fakeHarness({ order: D1_ORDER });
    const controller = new AbortController();
    const aborting: QlooCaller = {
      call: (name, args, signal) => {
        if (calls.length === 2) controller.abort();
        signal?.throwIfAborted();
        return mcp.call(name, args, signal);
      },
    };
    await expect(runAudit(aborting, D1_INPUT, { signal: controller.signal })).rejects.toThrow();
    expect(calls.length).toBe(2);
  });
});

describe("harness notes in a fresh audit", () => {
  it("records a degraded rank with warnings under ranking, not as success", async () => {
    const { mcp } = fakeHarness({
      order: { P: ["L", "C", "G"], O: ["G", "C", "L"] },
      rankOverride: (pool, signals) =>
        signals[0] === "O" ? { status: "degraded", warnings: ["1 of 3 lookups retried"], results: ["G", "C", "L"].filter((id) => pool.includes(id)).map((id) => ({ entity_id: id })) } : undefined,
    });
    const result = await runAudit(mcp, { headliner: "Phoebe Bridgers", references: ["Olivia Rodrigo"], shortlist: ["Lucy Dacus", "Clairo", "Gracie Abrams"] });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.qlooNotes).toEqual({ ranking: ["qloo_rank: degraded", "qloo_rank: 1 of 3 lookups retried"], explanation: [] });
  });
});


describe("Qloo rate limit", () => {
  const limited = { status: "error", error: { code: "QLOO_RATE_LIMIT", retryable: true } };

  it("retries a rate-limited rank and records each retry", async () => {
    let rankCalls = 0;
    const { mcp } = fakeHarness({
      order: { P: ["L", "C"], O: ["C", "L"] },
      rankOverride: () => (++rankCalls === 1 ? limited : undefined),
    });
    const { noting } = await import("../lib/audit");
    const notes: string[] = [];
    const out = await noting(mcp, notes, [1]).call("qloo_rank", { options: ["L", "C"], option_type: "artist", signals: ["P"] });
    expect(out.status).toBe("ok");
    expect(notes).toEqual(["qloo_rank: rate-limited by Qloo, retried after 0.001 s"]);
  });

  it("fails visibly once the retries are used up", async () => {
    const { mcp } = fakeHarness({ order: { P: ["L", "C"], O: ["C", "L"] }, rankOverride: () => limited });
    const { noting } = await import("../lib/audit");
    const notes: string[] = [];
    const out = await noting(mcp, notes, [1, 1]).call("qloo_rank", { options: ["L", "C"], option_type: "artist", signals: ["P"] });
    expect(out.status).toBe("error");
    expect(notes).toHaveLength(2);
  });
});
