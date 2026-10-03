// Model access and the brief writer. Server-only.
// Provider: any OpenAI-compatible endpoint (currently the OpenCode Go gateway with deepseek-flash).
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

/** The OpenCode Go gateway rejects requests without x-opencode-session (400 MissingSessionID). */
export function chatModel(session: string = randomUUID()) {
  const provider = createOpenAICompatible({
    name: "llm",
    baseURL: requireEnv("LLM_BASE_URL"),
    apiKey: requireEnv("LLM_API_KEY"),
    headers: { "x-opencode-session": `undercard-${session}` },
  });
  return provider(requireEnv("LLM_MODEL"));
}

export const Brief = z.object({
  priority: z.string().nullable().describe("Candidate to evaluate first, or null for no selection"),
  backups: z.array(z.string()).max(2),
  headlinerSide: z.string().describe("Why the priority fits (or not) the headliner's current audience"),
  targetSide: z.string().describe("Why the priority fits (or not) the target audience"),
  answer: z.string().describe("Direct answer to the team's question"),
  evidence: z.array(z.object({ claim: z.string(), source: z.enum(["qloo", "general_knowledge", "product_rule"]) })),
  unknowns: z.array(z.string()),
});
export type Brief = z.infer<typeof Brief>;

export const BRIEF_INSTRUCTIONS = [
  "You help an artist manager audit a support-act shortlist. The scenario is hypothetical and uses public artists.",
  "Booking fees, dates and willingness are checked by the team outside this tool; never claim them.",
  "Taste affinity is not ticket demand and does not prove new audience growth. Do not use percentages or invented numbers.",
  "Label every claim with its source: qloo (only if it appears in the provided Qloo evidence), general_knowledge, or product_rule.",
  "Choose only from the shortlist. You may return priority=null if nothing is defensible.",
  "Describe each side literally by its rank. The priority is a balance between sides: never call it the best, closest or strongest on a side where another act ranks higher; name that act instead.",
  "If priorityTiedWithNext is true, say the rule cannot separate the two acts and that the order shown is arbitrary (an internal id), not alphabetical and not a preference.",
  "Ranks exist only in the Qloo evidence. Without it, do not write numeric ranks, numbered orderings or positions as if measured; compare acts in words and label those judgements general_knowledge.",
  "If qlooNotes lists degraded or partial Qloo results, name them in unknowns and treat the affected evidence as weaker.",
  "Keep evidence to at most 8 items, the ones that matter most for the decision first.",
  // DeepSeek's json_object mode needs the word JSON and does not enforce field names, so the schema is spelled out.
  "Return a single JSON object with exactly these fields (JSON Schema): " + JSON.stringify(z.toJSONSchema(Brief)),
].join(" ");

export interface BriefRequest {
  caseText: string;
  /** Server-computed evidence; null produces the LLM-only baseline used in validation. */
  evidence: unknown | null;
  language?: string;
  signal?: AbortSignal;
}

/** Why a model output was rejected: the validation cause plus the tail of the raw text (no secrets in either). */
export function describeMalformed(e: NoObjectGeneratedError): string {
  const cause = e.cause instanceof Error ? e.cause.message : String(e.cause ?? "");
  return `finish=${e.finishReason ?? "?"}; cause=${cause.slice(0, 400)}; text_tail=${JSON.stringify(String(e.text ?? "").slice(-200))}`;
}

/** Retry budget for malformed (schema-mismatched) model output only. Observed rate ~3/60 in T13, not reproducible
 * on demand; one retry keeps a finished Qloo run from failing on a formatting slip. Every retry is reported. */
const MAX_ATTEMPTS = 2;

export async function writeBrief({ caseText, evidence, language = "English", signal }: BriefRequest) {
  const qlooPart = evidence
    ? "\n\nQloo evidence computed by the server (ranks are positions within this pool only; the priority and backups were chosen by the product rule " +
      "(worst side rank, then rank sum) and must not be changed; shared tags are similarity hints, not causes; you may flag concerns in unknowns):\n" +
      JSON.stringify(evidence, null, 2)
    : "\n\nNo Qloo data is available in this version. Use general knowledge and say so.";
  const started = Date.now();
  const malformed: string[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await generateText({
        model: chatModel(),
        system: BRIEF_INSTRUCTIONS,
        prompt: `${caseText}${qlooPart}\n\nWrite the brief in ${language}.`,
        output: Output.object({ schema: Brief }),
        abortSignal: signal,
      });
      return { ms: Date.now() - started, usage: result.totalUsage, brief: result.output, attempts: attempt, malformed };
    } catch (e) {
      if (!NoObjectGeneratedError.isInstance(e) || signal?.aborted) throw e;
      malformed.push(describeMalformed(e));
      console.warn(`[brief] malformed model output (attempt ${attempt}/${MAX_ATTEMPTS}): ${malformed.at(-1)}`);
      if (attempt >= MAX_ATTEMPTS) throw new Error(`The model returned malformed briefs ${attempt} times; last: ${malformed.at(-1)}`, { cause: e });
    }
  }
}
