// Two-sided trade-off at a glance (T19): x = rank for the headliner's fans, y = rank for the target audience,
// both within the same pool, so the best corner is top-left. The shaded square is the selection rule made
// visible: every act inside it has a worst-side rank no worse than the priority's. No hooks: used by the live
// page and the shared-link page. The rank table below it remains the accessible table view.
import type { RankRow } from "@/lib/audit";

type Point = Pick<RankRow, "id" | "name" | "headlinerRank" | "targetRank" | "worstRank"> & { role: "priority" | "backup" | "other" | "vetoed" };

const SIZE = 320;
const PAD = { left: 44, top: 16, right: 16, bottom: 40 };
const PLOT = SIZE - PAD.left - PAD.right;

export function TradeoffChart({ rows, vetoed, poolSize, priorityId, backupIds, headliner, target }: {
  rows: readonly RankRow[];
  vetoed: readonly RankRow[];
  poolSize: number;
  priorityId: string;
  backupIds: readonly string[];
  headliner: string;
  target: string;
}) {
  const n = Math.max(poolSize, 2);
  // Rank 1 sits at the inner edge of the first cell, rank n at the last; half a cell of margin on each side.
  const cell = PLOT / n;
  const at = (rank: number) => (rank - 0.5) * cell;
  const points: Point[] = [
    ...vetoed.filter((r) => Number.isFinite(r.headlinerRank)).map((r) => ({ ...r, role: "vetoed" as const })),
    ...rows.map((r) => ({ ...r, role: r.id === priorityId ? ("priority" as const) : backupIds.includes(r.id) ? ("backup" as const) : ("other" as const) })),
  ];
  const priority = rows.find((r) => r.id === priorityId);
  const zone = priority ? priority.worstRank * cell : 0;
  const ticks = Array.from({ length: n }, (_, i) => i + 1);
  // Axis titles must fit the plot side (~260 px at 11 px): long or multiple names fall back to the role.
  const xTitle = headliner.length <= 26 ? `${headliner}'s fans` : "Headliner's fans";
  const yTitle = target.length <= 22 && !target.includes(" + ") ? `${target} audience` : "Target audience";

  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-semibold">Trade-off map: each act&apos;s rank for both audiences</figcaption>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full max-w-sm text-current" role="img" aria-label={`Scatter of ${rows.length} acts: rank for ${headliner}'s fans against rank for the ${target} audience. Top-left is best on both.`}>
        <g transform={`translate(${PAD.left} ${PAD.top})`}>
          {priority && (
            <g>
              <rect x={0} y={0} width={zone} height={zone} rx={4} className="fill-violet-500/10 stroke-violet-500/50" strokeDasharray="4 3" />
              <text x={zone - 4} y={zone - 6} textAnchor="end" className="fill-current text-[9px] opacity-70">worst side ≤ #{priority.worstRank}</text>
            </g>
          )}
          {ticks.map((t) => (
            <g key={t} className="text-[10px]">
              <line x1={at(t)} x2={at(t)} y1={0} y2={PLOT} className="stroke-current opacity-[0.08]" />
              <line y1={at(t)} y2={at(t)} x1={0} x2={PLOT} className="stroke-current opacity-[0.08]" />
              <text x={at(t)} y={PLOT + 14} textAnchor="middle" className="fill-current opacity-60">#{t}</text>
              <text x={-8} y={at(t) + 3} textAnchor="end" className="fill-current opacity-60">#{t}</text>
            </g>
          ))}
          <text x={PLOT / 2} y={PLOT + 32} textAnchor="middle" className="fill-current text-[11px] opacity-80">→ {xTitle} (rank)</text>
          <text transform={`translate(-34 ${PLOT / 2}) rotate(-90)`} textAnchor="middle" className="fill-current text-[11px] opacity-80">→ {yTitle} (rank)</text>
          {points.map((p) => {
            const x = at(p.headlinerRank);
            const y = at(p.targetRank);
            // Labels sit beside the dot; on the right half they flip left so they stay inside the plot.
            const left = p.headlinerRank > n / 2;
            return (
              <g key={`${p.role}-${p.id}`}>
                <title>{`${p.name}${p.role === "vetoed" ? " (vetoed)" : ""}: #${p.headlinerRank} for ${headliner}'s fans, #${p.targetRank} for the target audience, worst side #${p.worstRank} of ${poolSize}`}</title>
                {/* Larger invisible hit target than the mark, for the hover tooltip. */}
                <circle cx={x} cy={y} r={14} fill="transparent" />
                {p.role === "priority" && <circle cx={x} cy={y} r={7} className="fill-violet-500 stroke-[var(--background)]" strokeWidth={2} />}
                {p.role === "backup" && <circle cx={x} cy={y} r={5.5} className="fill-[var(--background)] stroke-violet-400" strokeWidth={2} />}
                {p.role === "other" && <circle cx={x} cy={y} r={5} className="fill-current opacity-50" />}
                {p.role === "vetoed" && (
                  <g className="stroke-current opacity-40" strokeWidth={1.5}>
                    <line x1={x - 4} y1={y - 4} x2={x + 4} y2={y + 4} />
                    <line x1={x - 4} y1={y + 4} x2={x + 4} y2={y - 4} />
                  </g>
                )}
                <text
                  x={left ? x - 10 : x + 10}
                  y={y + 3.5}
                  textAnchor={left ? "end" : "start"}
                  className={`fill-current text-[10.5px] ${p.role === "priority" ? "font-semibold" : p.role === "vetoed" ? "line-through opacity-50" : "opacity-85"}`}
                >
                  {p.name}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-80" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-violet-500" />Priority</li>
        <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-violet-400" />Backup</li>
        <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-current opacity-50" />Other act</li>
        {vetoed.length > 0 && <li className="flex items-center gap-1.5"><span aria-hidden>✕</span>Vetoed</li>}
      </ul>
      <p className="text-xs opacity-70">
        {yTitle === "Target audience" && <>Target audience: {target}. </>}
        Top-left is closest to both audiences. The rule picks the act whose weaker side ranks best (the shaded square), so a strong rank on one side cannot hide a weak one on the other.
      </p>
    </figure>
  );
}
