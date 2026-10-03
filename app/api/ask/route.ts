// POST /api/ask {source:{kind:"state"|"share",token}, question, history?} — "Ask Undercard" follow-up agent.
// Streams NDJSON: {type:"tool",...} per Qloo tool call, {type:"heartbeat"} every 15 s, then
// {type:"answer",answer,trace,notes,ms} or {type:"error",message}.
// The audit context comes only from a signed token (live state or shared brief), so it cannot be forged;
// the question and earlier turns are user text. Counts toward the daily Qloo budget like an audit.
import { z } from "zod";
import { askAgent, type AskAudit } from "@/lib/ask";
import type { SavedBrief } from "@/lib/client/stream";
import { streamJob } from "@/lib/job-stream";
import { sharedQlooMcp } from "@/lib/qloo-mcp";
import { currentResult, runContext, type RunState } from "@/lib/replan";
import { decodeShare, MAX_TOKEN_LENGTH } from "@/lib/share";

const AskRequest = z.object({
  source: z.object({ kind: z.enum(["state", "share"]), token: z.string().max(MAX_TOKEN_LENGTH) }),
  question: z.string().trim().min(3).max(300),
  history: z.array(z.object({ question: z.string().max(300), answer: z.string().max(1500) })).max(3).optional(),
});

/** The fixed audit the agent reasons over, from a verified token; null when the token is invalid or has no priority. */
function auditFrom(source: z.infer<typeof AskRequest>["source"]): AskAudit | null {
  try {
    if (source.kind === "state") {
      const state = decodeShare<RunState>(source.token, "s1");
      const result = currentResult(state);
      const ctx = runContext(state);
      return result && { result, vetoed: ctx.vetoed, poolSize: ctx.originalPoolSize };
    }
    const saved = decodeShare<SavedBrief>(source.token, "v1");
    return { result: saved.result, vetoed: saved.context?.vetoed ?? [], poolSize: saved.context?.originalPoolSize ?? saved.result.table.length };
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const parsed = AskRequest.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const audit = auditFrom(parsed.data.source);
  if (!audit) return Response.json({ error: "invalid_state" }, { status: 400 });

  return streamJob(request, async ({ send, signal }) => {
    const out = await askAgent(sharedQlooMcp(), audit, parsed.data.question, {
      history: parsed.data.history,
      signal,
      onTool: (t) => send({ type: "tool", ...t }),
    });
    send({ type: "answer", answer: out.answer, trace: out.trace, notes: out.notes, ms: out.ms });
    console.info(`[ask] ${out.steps} steps, ${out.trace.length} tool calls, ${out.ms} ms`);
  });
}
