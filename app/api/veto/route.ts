// POST /api/veto {state, veto:{id,reason,note?}} — vetoes one act from a signed run state.
// Original-pool rerank: no new ranking. Qloo is called only to explain a changed priority.
// Streams the same NDJSON events as /api/audit, plus {type:"empty",context,state} when nobody is left.
import { z } from "zod";
import { streamJob } from "@/lib/job-stream";
import { sharedQlooMcp } from "@/lib/qloo-mcp";
import { applyVetoes, currentResult, VETO_REASONS, vetoRun, type RunState } from "@/lib/replan";
import { sendRunResult } from "@/lib/run-output";
import { decodeShare, MAX_TOKEN_LENGTH } from "@/lib/share";

const VetoRequest = z.object({
  state: z.string().max(MAX_TOKEN_LENGTH),
  veto: z.object({ id: z.string().min(1).max(64), reason: z.enum(VETO_REASONS), note: z.string().trim().max(200).optional() }),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = VetoRequest.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  let state: RunState;
  try {
    state = decodeShare<RunState>(parsed.data.state, "s1");
  } catch {
    return Response.json({ error: "invalid_state" }, { status: 400 });
  }
  // Reject before taking the run gate: vetoing an act outside the current pool is a client error.
  const current = currentResult(state);
  if (!current?.table.some((r) => r.id === parsed.data.veto.id)) return Response.json({ error: "not_in_pool" }, { status: 409 });
  // Qloo is called only when the veto changes the priority; other vetoes stay outside the daily Qloo budget.
  const next = applyVetoes(current.table, new Set([parsed.data.veto.id]))[0];
  const usesQloo = next !== undefined && next.id !== current.priority.id;
  const veto = { ...parsed.data.veto, note: parsed.data.veto.note || undefined };

  return streamJob(request, async ({ send, signal, started }) => {
    const after = await vetoRun(sharedQlooMcp(), state, veto, {
      signal,
      onProgress: (step, detail) => send({ type: "progress", step, detail, ms: Date.now() - started }),
    });
    await sendRunResult(after, { send, signal, started });
  }, { usesQloo });
}
