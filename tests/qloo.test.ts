import { describe, expect, it } from "vitest";
import { buildInsightsParams, buildSearchParams, configFromEnv, HACKATHON_BASE_URL } from "../lib/qloo";

describe("configFromEnv", () => {
  it("rejects a missing key", () => {
    expect(() => configFromEnv({ QLOO_BASE_URL: HACKATHON_BASE_URL })).toThrow(/QLOO_API_KEY/);
  });
  it("rejects non-hackathon base URLs", () => {
    expect(() => configFromEnv({ QLOO_API_KEY: "k", QLOO_BASE_URL: "https://api.qloo.com" })).toThrow(
      /QLOO_BASE_URL/,
    );
  });
});

describe("buildSearchParams", () => {
  it("joins types and trims the query", () => {
    expect(buildSearchParams("  Patsy Cline ", ["urn:entity:artist"])).toEqual({
      query: "Patsy Cline",
      types: "urn:entity:artist",
      take: "5",
    });
  });
  it("rejects an empty query", () => {
    expect(() => buildSearchParams("  ", ["urn:entity:artist"])).toThrow(/empty/);
  });
});

describe("buildInsightsParams", () => {
  it("dedupes seeds and omits empty optional params", () => {
    expect(buildInsightsParams({ type: "urn:entity:artist", seeds: ["a", "a ", "b"], exclude: [] })).toEqual({
      "filter.type": "urn:entity:artist",
      "signal.interests.entities": "a,b",
      take: "10",
    });
  });
  it("encodes exclusion, explainability and a movie year window", () => {
    const p = buildInsightsParams({
      type: "urn:entity:movie",
      seeds: ["a"],
      exclude: ["x"],
      explainability: true,
      releaseYear: { min: 1952, max: 1962 },
    });
    expect(p["filter.exclude.entities"]).toBe("x");
    expect(p["feature.explainability"]).toBe("true");
    expect(p["filter.release_year.min"]).toBe("1952");
    expect(p["filter.release_year.max"]).toBe("1962");
  });
  it("refuses a year filter on artists", () => {
    expect(() =>
      buildInsightsParams({ type: "urn:entity:artist", seeds: ["a"], releaseYear: { min: 1950, max: 1960 } }),
    ).toThrow(/only supported for movies/);
  });
  it("refuses an entity that is both seed and excluded", () => {
    expect(() => buildInsightsParams({ type: "urn:entity:movie", seeds: ["a"], exclude: ["a"] })).toThrow(/both seed/);
  });
  it("requires at least one seed", () => {
    expect(() => buildInsightsParams({ type: "urn:entity:movie", seeds: [" "] })).toThrow(/seed/);
  });
});
