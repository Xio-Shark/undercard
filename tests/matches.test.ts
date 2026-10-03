// "None of these" for ambiguous names (found by the H2 holdout: Wyatt Flores and Briscoe have no Qloo entity).
import { describe, expect, it } from "vitest";
import { applyMatchChoices, NONE } from "../lib/client/matches";

const request = { headliner: "Zach Bryan", references: ["Noah Kahan"], shortlist: ["Caamp", "Wyatt Flores", "Briscoe", "Medium Build"] };

describe("applyMatchChoices", () => {
  it("drops unmatched candidates and confirms the rest", () => {
    const out = applyMatchChoices({ ...request, shortlist: [...request.shortlist, "Nilüfer Yanya"] }, [
      { input: "Wyatt Flores", role: "candidate" },
      { input: "Nilüfer Yanya", role: "candidate" },
    ], { "Wyatt Flores": NONE, "Nilüfer Yanya": "E433873C" });
    expect(out).toEqual({
      body: { ...request, shortlist: ["Caamp", "Briscoe", "Medium Build", "Nilüfer Yanya"], confirmations: { "Nilüfer Yanya": "E433873C" } },
      removed: ["Wyatt Flores"],
    });
  });

  it("refuses to drop a headliner or reference", () => {
    const out = applyMatchChoices(request, [{ input: "Noah Kahan", role: "reference" }], { "Noah Kahan": NONE });
    expect(out).toEqual({ error: expect.stringContaining("edit the name") });
  });

  it("refuses a pool below 2 and unanswered names", () => {
    const two = { ...request, shortlist: ["Caamp", "Wyatt Flores"] };
    expect(applyMatchChoices(two, [{ input: "Wyatt Flores", role: "candidate" }], { "Wyatt Flores": NONE })).toEqual({ error: expect.stringContaining("fewer than 2") });
    expect(applyMatchChoices(request, [{ input: "Briscoe", role: "candidate" }], {})).toEqual({ error: "Answer every name first." });
  });
});
