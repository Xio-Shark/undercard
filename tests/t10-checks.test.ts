// T10 automated checks: rule and source constraints only (no quality judgement).
import { describe, expect, it } from "vitest";
import type { Brief } from "../lib/llm";
import { allPass, checkBrief } from "../scripts/t10-checks";

const brief = (over: Partial<Brief> = {}): Brief => ({
  priority: "Clairo", backups: ["Soccer Mommy"], headlinerSide: "h", targetSide: "t", answer: "a",
  evidence: [{ claim: "Clairo is #2 on the target side", source: "qloo" }], unknowns: ["fees"], ...over,
});
const inPlay = ["Clairo", "Soccer Mommy", "Julien Baker"];

describe("checkBrief", () => {
  it("passes a Qloo brief that keeps the rule's choice", () => {
    expect(allPass(checkBrief({ version: "qloo", brief: brief(), inPlay, vetoed: ["Lucy Dacus"], rulePriority: "Clairo" }))).toBe(true);
  });

  it("flags an overridden rule, an out-of-pool pick and a vetoed backup", () => {
    const c = checkBrief({ version: "qloo", brief: brief({ priority: "Gracie Abrams", backups: ["Lucy Dacus"] }), inPlay, vetoed: ["Lucy Dacus"], rulePriority: "Clairo" });
    expect(c).toMatchObject({ keptRule: false, priorityInPlay: false, respectsVetoes: false, backupsInPlay: false });
  });

  it("flags Qloo citations in the LLM-only version and percentage figures", () => {
    const c = checkBrief({ version: "llm_only", brief: brief({ answer: "about 40% overlap" }), inPlay, vetoed: [] });
    expect(c.qlooCitationsWithoutData).toBe(1);
    expect(c.percentFigures).toBe(1);
    expect(c.keptRule).toBeNull();
    expect(allPass(c)).toBe(false);
  });

  it("accepts an explicit no selection", () => {
    expect(allPass(checkBrief({ version: "llm_only", brief: brief({ priority: null, backups: [], evidence: [] }), inPlay, vetoed: [] }))).toBe(true);
  });
});

describe("numeric ranks without data", () => {
  it("flags rank-like numbers only in the LLM-only version", () => {
    const b = brief({ headlinerSide: "Headliner-side rank for Phoebe's audience: 1 Lucy Dacus, 2 Julien Baker. Clairo is #4.", evidence: [] });
    expect(checkBrief({ version: "llm_only", brief: b, inPlay, vetoed: [] }).numericRanksWithoutData).toBe(2);
    expect(checkBrief({ version: "qloo", brief: b, inPlay, vetoed: [], rulePriority: "Clairo" }).numericRanksWithoutData).toBe(0);
    expect(checkBrief({ version: "llm_only", brief: brief({ evidence: [], answer: "Clairo ranks higher than Lucy Dacus on the target side." }), inPlay, vetoed: [] }).numericRanksWithoutData).toBe(0);
  });
});


describe("name matching", () => {
  it("treats a capitalised spelling as the same act (T13: 'Beabadoobee' vs 'beabadoobee')", () => {
    const c = checkBrief({ version: "qloo", brief: brief({ priority: "Beabadoobee", backups: ["japanese breakfast"] }), inPlay: ["beabadoobee", "Japanese Breakfast"], vetoed: [], rulePriority: "beabadoobee" });
    expect(c).toMatchObject({ priorityInPlay: true, backupsInPlay: true, keptRule: true });
  });
});
