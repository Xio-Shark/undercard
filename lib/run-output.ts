// Final step shared by /api/audit and /api/veto: brief for the current state, then the result event
// with a freshly signed state token. An empty pool stops here without a brief.
import type { Send } from "./job-stream";
import { writeBrief } from "./llm";
import { briefInput, currentResult, runContext, type RunState } from "./replan";
import { encodeShare } from "./share";

export async function sendRunResult(state: RunState, ctx: { send: Send; signal: AbortSignal; started: number }): Promise<void> {
  const { send, signal, started } = ctx;
  const token = encodeShare(state, "s1");
  const current = currentResult(state);
  if (!current) {
    send({ type: "empty", context: runContext(state), state: token, ms: Date.now() - started });
    return;
  }
  send({ type: "progress", step: "brief", ms: Date.now() - started });
  const { caseText, evidence } = briefInput(state, current);
  const { brief, usage, ms, attempts, malformed } = await writeBrief({ caseText, evidence, language: state.input.language, signal });
  // The model must not override the server's selection; a mismatch is surfaced, not silently fixed.
  // Case-insensitive: "Beabadoobee" for Qloo's "beabadoobee" is the same act.
  const priorityKept = brief.priority?.trim().toLowerCase() === current.priority.name.toLowerCase();
  send({ type: "result", result: current, brief, priorityKept, context: runContext(state), state: token, model: { ms, usage, attempts, malformed }, ms: Date.now() - started });
}
