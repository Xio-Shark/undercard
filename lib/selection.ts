// Undercard's relative selection rule (docs/requirements.md "选择规则").
// Ranks are 1-based positions from two qloo_rank calls over the SAME pool. Raw affinities are never
// compared across calls. Sort key: (worst side rank, rank sum, stable id). The id only stabilizes
// display order; it is not a preference.

export type Ranks = ReadonlyMap<string, number>;

export interface Coverage {
  complete: boolean;
  /** Pool ids without a rank on side A or side B. */
  missing: string[];
}

/** The rule's key for one candidate: (worst side rank, rank sum). Single definition for sorting and ties. */
export const selectionKey = (rankA: number, rankB: number) => [Math.max(rankA, rankB), rankA + rankB] as const;

/** True when two (rankA, rankB) pairs share both key components, i.e. the rule cannot separate them. */
export function sameKey(x: readonly [number, number], y: readonly [number, number]): boolean {
  const [kx, ky] = [selectionKey(...x), selectionKey(...y)];
  return kx[0] === ky[0] && kx[1] === ky[1];
}

export function checkCoverage(pool: readonly string[], a: Ranks, b: Ranks): Coverage {
  const missing = pool.filter((id) => !a.has(id) || !b.has(id));
  return { complete: missing.length === 0, missing };
}

/** Orders the pool by the selection key. Throws if any candidate lacks a rank: partial pools get no priority. */
export function selectionOrder(pool: readonly string[], a: Ranks, b: Ranks): string[] {
  const { complete, missing } = checkCoverage(pool, a, b);
  if (!complete) throw new Error(`Cannot select from a partial pool; missing ranks for: ${missing.join(", ")}`);
  const key = (id: string) => selectionKey(a.get(id)!, b.get(id)!);
  return [...pool].sort((x, y) => {
    const [kx, ky] = [key(x), key(y)];
    return kx[0] - ky[0] || kx[1] - ky[1] || (x < y ? -1 : x > y ? 1 : 0);
  });
}

/** True when two candidates share both key components, i.e. the rule cannot separate them. */
export function isTie(x: string, y: string, a: Ranks, b: Ranks): boolean {
  return sameKey([a.get(x)!, b.get(x)!], [a.get(y)!, b.get(y)!]);
}
