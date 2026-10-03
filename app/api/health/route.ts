// GET /api/health — reports configuration and whether the qloo mcp child process answers tools/list.
// It never calls a Qloo workflow tool, so it costs no Qloo quota.
import { sharedAuditGate } from "@/lib/limits";
import { sharedQlooMcp } from "@/lib/qloo-mcp";

const REQUIRED_ENV = ["QLOO_API_KEY", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "SHARE_SECRET"];

export async function GET(): Promise<Response> {
  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
  let mcp: { ok: boolean; tools?: number; error?: string };
  try {
    const tools = await sharedQlooMcp().listTools();
    mcp = { ok: tools.includes("qloo_rank"), tools: tools.length };
  } catch (e) {
    mcp = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const ok = missingEnv.length === 0 && mcp.ok;
  return Response.json({ ok, missingEnv, mcp, audits: sharedAuditGate().usage() }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
