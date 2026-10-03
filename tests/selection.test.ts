import { describe, expect, it } from "vitest";
import { checkCoverage, isTie, selectionOrder } from "../lib/selection";

const ranks = (entries: [string, number][]) => new Map(entries);

describe("selectionOrder", () => {
  it("prefers the better worst-side rank over a side winner (technical-design example)", () => {
    const a = ranks([["X1", 1], ["X2", 2], ["X3", 3]]);
    const b = ranks([["X1", 3], ["X2", 2], ["X3", 1]]);
    expect(selectionOrder(["X1", "X2", "X3"], a, b)[0]).toBe("X2");
  });

  it("breaks equal worst rank by rank sum", () => {
    const a = ranks([["P", 1], ["Q", 3]]);
    const b = ranks([["P", 3], ["Q", 3]]);
    expect(selectionOrder(["Q", "P"], a, b)).toEqual(["P", "Q"]);
  });

  it("keeps the same top choice when both sides agree", () => {
    const a = ranks([["A", 1], ["B", 2]]);
    const b = ranks([["A", 1], ["B", 2]]);
    expect(selectionOrder(["B", "A"], a, b)[0]).toBe("A");
  });

  it("is symmetric when the two sides are swapped", () => {
    const a = ranks([["L", 1], ["C", 4], ["S", 3], ["G", 5], ["J", 2]]);
    const b = ranks([["L", 3], ["C", 2], ["S", 4], ["G", 1], ["J", 5]]);
    const pool = ["L", "C", "S", "G", "J"];
    expect(selectionOrder(pool, a, b)).toEqual(selectionOrder(pool, b, a));
  });

  it("orders exact ties by id only and reports them as ties", () => {
    const a = ranks([["b", 1], ["a", 2]]);
    const b = ranks([["b", 2], ["a", 1]]);
    expect(selectionOrder(["b", "a"], a, b)).toEqual(["a", "b"]);
    expect(isTie("a", "b", a, b)).toBe(true);
  });

  it("refuses to select from a partial pool", () => {
    const a = ranks([["x", 1], ["y", 2]]);
    const b = ranks([["x", 1]]);
    expect(checkCoverage(["x", "y"], a, b)).toEqual({ complete: false, missing: ["y"] });
    expect(() => selectionOrder(["x", "y"], a, b)).toThrow(/partial pool.*y/);
  });

  it("keeps original ranks after a veto (original-pool rerank)", () => {
    const a = ranks([["L", 1], ["C", 4], ["S", 3], ["G", 5], ["J", 2]]);
    const b = ranks([["L", 3], ["C", 2], ["S", 4], ["G", 1], ["J", 5]]);
    const order = selectionOrder(["C", "S", "G", "J"], a, b);
    expect(order[0]).toBe("C");
  });
});
