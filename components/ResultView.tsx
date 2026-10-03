// Read-only rendering of a complete audit + brief. No hooks: used by the live page and the shared-link page.
// The live page passes `rowAction` (veto controls); the shared page does not.
import type { ReactNode } from "react";
import type { AuditResult, RankRow, SideComparison } from "@/lib/audit";
import type { Brief } from "@/lib/llm";
import { VETO_LABEL, type RunContext } from "@/lib/replan";

type Complete = Extract<AuditResult, { status: "complete" }>;

const SOURCE_STYLE: Record<string, string> = {
  qloo: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  product_rule: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  general_knowledge: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
};
const SOURCE_LABEL: Record<string, string> = { qloo: "Qloo", product_rule: "Rule", general_knowledge: "General knowledge" };
// Region and time-signature style tags are frequent, generic matches (T05); they are shown but marked.
const GENERIC_KINDS = new Set(["region"]);

function Comparison({ title, side }: { title: string; side: SideComparison }) {
  return (
    <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
      <h4 className="text-sm font-semibold">{title}</h4>
      <p className="mt-2 text-xs uppercase tracking-wide opacity-60">Shared audience tags</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {side.sharedTags.map((t) => (
          <li
            key={t.tag}
            title={`${t.kind} · similarity ${t.score}`}
            className={`rounded-full px-2 py-0.5 text-xs ${GENERIC_KINDS.has(t.kind) ? "border border-dashed border-black/20 opacity-60 dark:border-white/25" : "bg-black/5 dark:bg-white/10"}`}
          >
            {t.tag}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs opacity-70">
        Only on the left side: {side.onlyGroup.slice(0, 5).join(", ") || "—"} · Only for the candidate: {side.onlyCandidate.slice(0, 5).join(", ") || "—"}
      </p>
    </div>
  );
}

const time = (iso: string) => new Date(iso).toUTCString().replace(" GMT", " UTC");

/** "Latest change": whether the priority changed, what triggered it, and when the evidence was queried. */
export function ChangeSummary({ context }: { context: RunContext }) {
  const c = context.change;
  if (!c) return null;
  const moved = c.priorityBefore !== c.priorityAfter;
  return (
    <div className="rounded-lg border border-sky-500/40 bg-sky-50/60 p-4 text-sm dark:bg-sky-950/30">
      <p className="text-xs font-semibold uppercase tracking-wide text-sky-800 dark:text-sky-300">
        Latest change · {c.kind === "veto" ? "original-pool rerank" : "new query"}
      </p>
      <p className="mt-1">{c.trigger}.</p>
      <p className="mt-1">
        Priority: {moved ? <><s className="opacity-60">{c.priorityBefore ?? "none"}</s> → <strong>{c.priorityAfter ?? "none"}</strong></> : <>unchanged (<strong>{c.priorityAfter ?? "none"}</strong>)</>}
      </p>
      <p className="mt-1 text-xs opacity-70">
        Ranks queried {time(context.rankedAt)}
        {context.explanation && ` · explanation ${context.explanation.refetched ? "re-queried" : "queried"} ${time(context.explanation.at)}`}
        {c.kind === "new_query" && " · ranks from a different pool are not comparable with the previous run"}
      </p>
    </div>
  );
}

function VetoedRows({ context, colSpan }: { context: RunContext; colSpan: number }) {
  return context.vetoed.map((v) => (
    <tr key={v.id} className="border-t border-black/10 text-sm opacity-60 dark:border-white/10">
      <td className="py-1.5 pr-3"><s>{v.name}</s> <span className="text-xs">vetoed · {VETO_LABEL[v.reason]}{v.note ? ` — ${v.note}` : ""}</span></td>
      {v.beforeQuery ? (
        <td className="py-1.5 text-xs" colSpan={colSpan}>removed before this query; not ranked</td>
      ) : (
        <>
          <td className="py-1.5 pr-3">#{v.headlinerRank}</td>
          <td className="py-1.5 pr-3">#{v.targetRank}</td>
          <td className="py-1.5" colSpan={colSpan - 2}>#{v.worstRank}</td>
        </>
      )}
    </tr>
  ));
}

export function ResultView({ result, brief, savedAt, context, rowAction }: { result: Complete; brief: Brief; savedAt?: string; context?: RunContext; rowAction?: (row: RankRow) => ReactNode }) {
  // Denominator stays the original pool: vetoes remove rows without renumbering.
  const n = context?.originalPoolSize ?? result.table.length;
  const p = result.priority;
  const rerank = context?.label === "rerank";
  return (
    <section className="space-y-6" aria-label="Audit result">
      {savedAt && <p className="text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">Saved run · {new Date(savedAt).toUTCString()}</p>}
      {context && <ChangeSummary context={context} />}

      <div className="rounded-xl border-2 border-violet-500/60 p-5">
        <p className="text-xs uppercase tracking-wide opacity-60">
          Priority for review within this shortlist{rerank && " · original-pool rerank"}
        </p>
        <h3 className="mt-1 text-2xl font-bold">{p.name}</h3>
        <p className="mt-2 text-sm">
          Headliner proxy <strong>#{p.headlinerRank}</strong> of {n} · Target proxy <strong>#{p.targetRank}</strong> of {n} · Worst side <strong>#{p.worstRank}</strong>
          {rerank && <span className="opacity-70"> (ranks from the original pool of {n}; vetoed acts removed, not re-ranked)</span>}
        </p>
        {result.table.length === 1 && (
          <p className="mt-2 rounded bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
            Only one candidate left (original pool of {n}). Being last standing does not make {p.name} a good fit.
          </p>
        )}
        {result.priorityTied && (
          <p className="mt-2 rounded bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
            Tie: {p.name} and {result.table[1].name} have the same worst rank and rank sum. The rule does not separate them; the order shown is alphabetical by id.
          </p>
        )}
        {result.backups.length > 0 && <p className="mt-2 text-sm opacity-80">Backups: {result.backups.map((b) => b.name).join(", ")}</p>}
        <p className="mt-3 text-xs opacity-60">Relative to this pool only. Affinity is not ticket demand, booking fee, availability or willingness.</p>
      </div>

      {(result.qlooNotes?.ranking.length || result.qlooNotes?.explanation.length) ? (
        <div className="rounded-md border border-amber-400/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
          <p className="font-medium">Qloo flagged part of this run. Treat the affected evidence as weaker.</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {result.qlooNotes.ranking.map((n, i) => <li key={`r${i}`}>Ranking: {n}</li>)}
            {result.qlooNotes.explanation.map((n, i) => <li key={`e${i}`}>Explanation for {p.name}: {n}</li>)}
          </ul>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <caption className="mb-2 text-left text-sm font-semibold">Shortlist ranks (same pool, two Qloo rank calls)</caption>
          <thead className="text-xs uppercase opacity-60">
            <tr>
              <th className="py-1 pr-3">Act</th>
              <th className="py-1 pr-3">Headliner proxy</th>
              <th className="py-1 pr-3">Target proxy</th>
              <th className="py-1 pr-3">Worst side</th>
            </tr>
          </thead>
          <tbody>
            {result.table.map((r) => (
              <tr key={r.id} className={`border-t border-black/10 dark:border-white/10 ${r.id === p.id ? "font-semibold" : ""}`}>
                <td className="py-1.5 pr-3">
                  {r.name}
                  {r.tiedWithPrevious && <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-300">tie</span>}
                  {/* Under the name, not in a last column: on phones the table scrolls and a trailing column is off-screen. */}
                  {rowAction && <div className="mt-0.5 font-normal">{rowAction(r)}</div>}
                </td>
                <td className="py-1.5 pr-3">#{r.headlinerRank}</td>
                <td className="py-1.5 pr-3">#{r.targetRank}</td>
                <td className="py-1.5 pr-3">#{r.worstRank}</td>
              </tr>
            ))}
            {context && <VetoedRows context={context} colSpan={3} />}
          </tbody>
        </table>
      </div>

      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Brief</h3>
        <p className="leading-relaxed">{brief.answer}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div><h4 className="text-sm font-semibold">Headliner&apos;s audience</h4><p className="mt-1 text-sm leading-relaxed opacity-90">{brief.headlinerSide}</p></div>
          <div><h4 className="text-sm font-semibold">Target audience</h4><p className="mt-1 text-sm leading-relaxed opacity-90">{brief.targetSide}</p></div>
        </div>
        <h4 className="pt-2 text-sm font-semibold">Evidence and sources</h4>
        <ul className="space-y-1.5 text-sm">
          {brief.evidence.map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${SOURCE_STYLE[e.source]}`}>{SOURCE_LABEL[e.source]}</span>
              <span>{e.claim}</span>
            </li>
          ))}
        </ul>
        <h4 className="pt-2 text-sm font-semibold">Unknown or unsupported</h4>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {brief.unknowns.map((u, i) => <li key={i}>{u}</li>)}
        </ul>
      </div>

      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Audience comparison for {p.name}</h3>
        <p className="text-xs opacity-70">
          Similarity hints from Qloo, not causes. Dashed tags are generic (e.g. regions).
          {context?.explanation && ` ${context.explanation.refetched ? "Re-queried for " + p.name + " after a veto" : "Queried with the ranks"}, ${time(context.explanation.at)}.`}
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <Comparison title={`${result.headliner.name} vs ${p.name}`} side={result.evidence.headlinerVsPriority} />
          <Comparison title={`${result.references.map((r) => r.name).join(" + ")} vs ${p.name}`} side={result.evidence.targetVsPriority} />
        </div>
      </div>
    </section>
  );
}
