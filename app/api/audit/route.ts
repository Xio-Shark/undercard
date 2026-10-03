// POST /api/audit — runs one live query and streams NDJSON events:
//   {type:"progress",step,detail} and {type:"heartbeat"} every 15 s ... then one of
//   {type:"result",result} (needs_input | invalid_pool | partial)  or
//   {type:"result",result,brief,context,state} (complete)  or  {type:"error",message}
// `previous` (a signed run state) marks a re-query after editing references: its vetoes stay excluded
// and the result carries a change summary labeled "new query".
// Disconnecting the client aborts the remaining Qloo and model calls.
import { z } from "zod";
import { runAudit } from "@/lib/audit";
import { streamJob } from "@/lib/job-stream";
import { stateFromQuery, type RunState } from "@/lib/replan";
import { sendRunResult } from "@/lib/run-output";
import { sharedQlooMcp } from "@/lib/qloo-mcp";
import { decodeShare, MAX_TOKEN_LENGTH } from "@/lib/share";

const name = z.string().trim().min(1).max(120);
const AuditRequest = z.object({
  headliner: name,
  references: z.array(name).min(1).max(3),
  shortlist: z.array(name).min(2).max(10),
  confirmations: z.record(name, z.string().uuid()).optional(),
  question: z.string().trim().max(600).optional(),
  language: z.enum(["English", "Chinese"]).optional(),
  previous: z.string().max(MAX_TOKEN_LENGTH).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = AuditRequest.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return Response.json({ error: "invalid_request", issues: parsed.error.issues }, { status: 400 });
  const { previous: token, ...input } = parsed.data;
  let previous: RunState | undefined;
  try {
    previous = token ? decodeShare<RunState>(token, "s1") : undefined;
  } catch {
    return Response.json({ error: "invalid_state" }, { status: 400 });
  }

  return streamJob(request, async ({ send, signal, started }) => {
    const queryInput = { ...input, vetoedIds: previous?.vetoes.map((v) => v.id) };
    const result = await runAudit(sharedQlooMcp(), queryInput, {
      signal,
      onProgress: (step, detail) => send({ type: "progress", step, detail, ms: Date.now() - started }),
    });
    if (result.status !== "complete") {
      send({ type: "result", result, ms: Date.now() - started });
      return;
    }
    await sendRunResult(stateFromQuery(input, result, new Date().toISOString(), previous), { send, signal, started });
  });
}
