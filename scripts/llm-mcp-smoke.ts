// Smoke test: the configured LLM drives the official `qloo mcp` tools through AI SDK (production path).
// Run: pnpm smoke:llm   (reads LLM_* and QLOO_* from .env.local). Uses the D1 dev case only; not evidence for T05.
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isStepCount, ToolLoopAgent } from "ai";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ALLOWED_TOOLS = ["qloo_describe", "qloo_rank", "qloo_compare_audiences"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing; see .env.example.`);
  return value;
}

async function main(): Promise<void> {
  // The OpenCode Go gateway rejects requests without x-opencode-session (400 MissingSessionID).
  const provider = createOpenAICompatible({
    name: "opencode-go",
    baseURL: requireEnv("LLM_BASE_URL"),
    apiKey: requireEnv("LLM_API_KEY"),
    headers: { "x-opencode-session": `undercard-smoke-${randomUUID()}` },
  });
  // Only Qloo settings reach the MCP child process; the LLM key stays in this process.
  const qlooEnv = Object.fromEntries(
    ["PATH", "HOME", "QLOO_API_KEY", "QLOO_BASE_URL", "QLOO_TRUSTED_BASE_URL"]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]!]),
  );
  const mcp = await createMCPClient({
    transport: new Experimental_StdioMCPTransport({
      command: "pnpm",
      args: ["exec", "qloo", "mcp"],
      env: { ...qlooEnv, QLOO_HOME: resolve(".qloo-home") },
    }),
  });
  const started = Date.now();
  try {
    const all = await mcp.tools();
    const tools = Object.fromEntries(Object.entries(all).filter(([name]) => ALLOWED_TOOLS.includes(name)));
    const agent = new ToolLoopAgent({
      model: provider(requireEnv("LLM_MODEL")),
      instructions:
        "You audit a support-act shortlist for a headliner. Use only the Qloo tools. Resolve names with qloo_describe, " +
        "rank the same shortlist twice with qloo_rank (once with the headliner as signal, once with the target reference), " +
        "then compare audiences for the best-balanced candidate. Report ranks exactly as returned; never invent data.",
      tools,
      stopWhen: isStepCount(12),
    });
    const result = await agent.generate({
      prompt:
        "Headliner: Phoebe Bridgers. Target audience reference: Olivia Rodrigo. " +
        "Shortlist: Lucy Dacus, Julien Baker, Soccer Mommy, Clairo, Gracie Abrams. Hypothetical scenario.",
    });
    const toolCalls = result.steps.flatMap((s) => s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input })));
    const summary = {
      ms: Date.now() - started,
      steps: result.steps.length,
      finishReason: result.finishReason,
      toolCalls,
      toolErrors: result.steps.flatMap((s) => s.content.filter((p) => p.type === "tool-error")).length,
      usage: result.totalUsage,
      text: result.text,
    };
    const dir = join(".probe", "llm-smoke");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ ...summary, steps: result.steps }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await mcp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
