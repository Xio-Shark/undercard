// "Ask Undercard" (T19): a follow-up agent over one finished audit. The model decides which Qloo tools to
// call (through the same long-lived `qloo mcp`, serial queue and rate-limit retry as the audit) to answer the
// team's question. It cannot change the audit: the priority stays the server rule's, and any new ranking it
// runs is labeled exploratory. Server-only.
import { generateText, isStepCount, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { compare, noting, type AuditResult, type QlooCaller, type RankRow, type SideComparison } from "./audit";
import { chatModel } from "./llm";
import type { Envelope } from "./qloo-mcp";

type Complete = Extract<AuditResult, { status: "complete" }>;

/** Qloo tool calls one question may make; with rank fan-out this bounds a question to roughly 40 Qloo requests. */
export const MAX_TOOL_CALLS = 6;
/** Model steps: tool rounds plus the final answer. */
const MAX_STEPS = MAX_TOOL_CALLS + 2;

export interface AskTurn { question: string; answer: string }
export interface TraceItem { tool: string; input: string; output: string; ok: boolean }
export interface AskAudit { result: Complete; vetoed: (RankRow & { beforeQuery?: boolean })[]; poolSize: number }

const uuid = z.string().uuid();

export const ASK_INSTRUCTIONS = [
  "You are Undercard's follow-up analyst. An artist manager's team ran a support-act shortlist audit; you answer their follow-up question.",
  "The audit below is fixed. Its priority was chosen by a server rule (best worst-side rank, then rank sum) and you must never say it should change or pick a different priority yourself.",
  "Use the audit data first. Call Qloo tools only when the question needs data the audit does not have (another artist's audience, a comparison not yet run, an unknown name).",
  "Any ranking you run with rank_for_audience is exploratory: positions only within the options you passed, not comparable with the audit's ranks or scores. Say so when you report it.",
  "Never invent ranks, tags or numbers. Copy an act's ranks from its line in ranks and keep the headliner side and the target side apart. Shared tags are similarity hints, not causes; there are no similarity scores, so never compare tag strength between acts or calls. Affinity is not ticket demand, fees, dates or willingness.",
  "If the team wants the audit itself to change, tell them to veto an act or edit the target references on the page.",
  `You may make at most ${MAX_TOOL_CALLS} tool calls. Pass Qloo entity ids (UUIDs) to rank and compare; use lookup_artist to get an id for a new name.`,
  "Answer in plain prose for a busy manager: at most 120 words, no headings, no JSON, no field names. Start with the direct answer.",
].join(" ");

/** Shared tags without similarity scores: scores from different compare calls are not comparable (T04), so the agent never sees them. */
const tagsOnly = (side: SideComparison) => ({ sharedTags: side.sharedTags.map((t) => t.tag), onlyGroup: side.onlyGroup, onlyCandidate: side.onlyCandidate });

/** The audit as the model reads it: ids for tool calls, and each act's ranks spelled out in one line
 * (T19: with bare JSON fields the model swapped an act's headliner and target ranks). */
export function auditContext({ result, vetoed, poolSize }: AskAudit) {
  const h = result.headliner.name;
  const line = (r: Pick<RankRow, "name" | "headlinerRank" | "targetRank" | "worstRank">) =>
    `${r.name}: #${r.headlinerRank} of ${poolSize} for ${h}'s fans, #${r.targetRank} of ${poolSize} for the target audience, weaker side #${r.worstRank}`;
  return {
    headliner: { id: result.headliner.id, name: h },
    targetReferences: result.references.map((r) => ({ id: r.id, name: r.name })),
    ids: Object.fromEntries([...result.table, ...vetoed].map((r) => [r.name, r.id])),
    ranks: [
      `Ranks are positions within this pool of ${poolSize}, from two Qloo rank calls; 1 is closest.`,
      ...result.table.map((r) => line(r) + (r.id === result.priority.id ? " (PRIORITY)" : "")),
      ...vetoed.map((r) => (r.beforeQuery ? `${r.name}: vetoed before this query, not ranked` : `${line(r)} (vetoed by the team)`)),
    ],
    rule: `The priority is the act with the best weaker-side rank, then the best rank sum. Priority: ${result.priority.name}${result.priorityTied ? " (tied with the next act; the order between them is arbitrary)" : ""}. Backups: ${result.backups.map((b) => b.name).join(", ") || "none"}.`,
    audienceComparisonForPriority: {
      [`${h} vs ${result.priority.name}`]: tagsOnly(result.evidence.headlinerVsPriority),
      [`target references vs ${result.priority.name}`]: tagsOnly(result.evidence.targetVsPriority),
    },
  };
}

const short = (v: unknown, max = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** The three Qloo tools the agent may use. Every call is budgeted and recorded in `trace` for the page. */
export function askTools(mcp: QlooCaller, trace: TraceItem[], names: Map<string, string>, opts: { signal?: AbortSignal; onTool?: (t: TraceItem) => void } = {}) {
  let calls = 0;
  // `input` is a readable description; ids in it are replaced by artist names for the page.
  const run = async <T>(name: string, input: string, fn: () => Promise<T>, summarize: (out: T) => string): Promise<T | { error: string }> => {
    if (calls >= MAX_TOOL_CALLS) return { error: `Tool budget of ${MAX_TOOL_CALLS} calls is used up; answer with what you have.` };
    calls++;
    const label = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => names.get(id.toUpperCase()) ?? "unknown id");
    try {
      const out = await fn();
      const item = { tool: name, input: short(label(input)), output: summarize(out), ok: true };
      trace.push(item);
      opts.onTool?.(item);
      return out;
    } catch (e) {
      // Reported to the model and shown on the page; the agent answers with what it has.
      const message = e instanceof Error ? e.message : String(e);
      const item = { tool: name, input: short(label(input)), output: message, ok: false };
      trace.push(item);
      opts.onTool?.(item);
      return { error: message };
    }
  };
  const { signal } = opts;
  const status = (out: Envelope, tool: string) => {
    if (out.status === "error" || out.status === undefined) throw new Error(`${tool}: ${String((out.error as { code?: string } | undefined)?.code ?? "error")}`);
  };

  return {
    lookup_artist: tool({
      description: "Find the Qloo artist entity for a name. Returns its id, or the candidates when the name is ambiguous.",
      inputSchema: z.object({ name: z.string().min(1).max(120) }),
      execute: ({ name }) =>
        run("lookup_artist", `"${name}"`, async () => {
          const out = await mcp.call("qloo_describe", { entity: name, type: "artist" }, signal);
          if (out.status === "needs_input") {
            const issue = ((out.resolution as Envelope)?.issues as Envelope[] | undefined)?.[0];
            const choices = ((issue?.candidates as Envelope[]) ?? []).slice(0, 5).map((c) => ({ id: String(c.id), name: String(c.name), description: c.description ? short(c.description, 100) : undefined }));
            choices.forEach((c) => names.set(c.id.toUpperCase(), c.name));
            return { status: "ambiguous" as const, choices };
          }
          status(out, "qloo_describe");
          const e = (out.interpretation as { entity?: { entityId?: string; name?: string } })?.entity;
          if (!e?.entityId) return { status: "not_found" as const };
          names.set(e.entityId.toUpperCase(), e.name ?? name);
          return { status: "ok" as const, id: e.entityId, name: e.name ?? name };
        }, (o) => (o.status === "ok" ? `${o.name}` : o.status === "ambiguous" ? `ambiguous: ${o.choices.map((c) => c.name).join(", ")}` : "not found in Qloo")),
    }),
    rank_for_audience: tool({
      description: "Exploratory: rank 2-10 artists (option_ids) by affinity with the audience of 1-3 signal artists (signal_ids). Positions are only within these options.",
      inputSchema: z.object({ option_ids: z.array(uuid).min(2).max(10), signal_ids: z.array(uuid).min(1).max(3) }),
      execute: ({ option_ids, signal_ids }) =>
        run("rank_for_audience", `${option_ids.length} acts for fans of ${signal_ids.join(" + ")}`, async () => {
          const out = await mcp.call("qloo_rank", { options: option_ids, option_type: "artist", signals: signal_ids }, signal);
          status(out, "qloo_rank");
          const ranking = ((out.results as Envelope[]) ?? []).map((r, i) => ({ rank: i + 1, id: String(r.entity_id), name: String(r.name ?? names.get(String(r.entity_id).toUpperCase()) ?? r.entity_id) }));
          const ranked = new Set(ranking.map((r) => r.id.toUpperCase()));
          const unranked = option_ids.filter((id) => !ranked.has(id.toUpperCase())).map((id) => names.get(id.toUpperCase()) ?? id);
          return { exploratory: true, ranking, unranked };
        }, (o) => o.ranking.map((r) => `#${r.rank} ${r.name}`).join(", ") + (o.unranked.length ? ` · unranked: ${o.unranked.join(", ")}` : "")),
    }),
    compare_audiences: tool({
      description: "Compare the audience of 1-3 group artists with one candidate artist: shared audience tags and tags only on each side.",
      inputSchema: z.object({ group_ids: z.array(uuid).min(1).max(3), candidate_id: uuid }),
      execute: ({ group_ids, candidate_id }) =>
        run("compare_audiences", `${group_ids.join(" + ")} vs ${candidate_id}`, async () => tagsOnly(await compare(mcp, group_ids, candidate_id, signal)), (o) => `shared: ${o.sharedTags.slice(0, 6).join(", ") || "none"}`),
    }),
  };
}

export async function askAgent(
  mcp: QlooCaller,
  audit: AskAudit,
  question: string,
  opts: { history?: AskTurn[]; signal?: AbortSignal; model?: LanguageModel; onTool?: (t: TraceItem) => void } = {},
) {
  const trace: TraceItem[] = [];
  const notes: string[] = [];
  const context = auditContext(audit);
  const names = new Map<string, string>(
    [context.headliner, ...context.targetReferences, ...Object.entries(context.ids).map(([name, id]) => ({ id, name }))].map((e) => [e.id.toUpperCase(), e.name] as const),
  );
  const history = (opts.history ?? []).flatMap((t) => [
    { role: "user" as const, content: t.question },
    { role: "assistant" as const, content: t.answer },
  ]);
  const started = Date.now();
  const result = await generateText({
    model: opts.model ?? chatModel(),
    system: `${ASK_INSTRUCTIONS}\n\nThe audit (fixed):\n${JSON.stringify(context, null, 1)}`,
    messages: [...history, { role: "user", content: question }],
    tools: askTools(noting(mcp, notes), trace, names, { signal: opts.signal, onTool: opts.onTool }),
    stopWhen: isStepCount(MAX_STEPS),
    abortSignal: opts.signal,
  });
  const answer = result.text.trim();
  // An empty answer is a failure the page must show, not a blank bubble.
  if (!answer) throw new Error(`The agent stopped without an answer (finish reason: ${result.finishReason}, ${result.steps.length} steps).`);
  return { answer, trace, notes, steps: result.steps.length, ms: Date.now() - started, usage: result.totalUsage };
}
