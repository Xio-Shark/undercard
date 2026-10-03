// GET /api/health — reports configuration and whether the qloo mcp child process answers tools/list.
// It never calls a Qloo workflow tool, so it costs no Qloo quota.
// GET /api/health?deep=1 — also proves the Qloo and model keys work (lib/deep-health.ts, cached 6 h).
import { cachedDeep } from "@/lib/deep-health";
import { sharedAuditGate } from "@/lib/limits";
import { sharedQlooMcp } from "@/lib/qloo-mcp";

const REQUIRED_ENV = ["QLOO_API_KEY", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "SHARE_SECRET"];

export async function GET(request: Request): Promise<Response> {
  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
  let mcp: { ok: boolean; tools?: number; error?: string };
  try {
    const tools = await sharedQlooMcp().listTools();
    mcp = { ok: tools.includes("qloo_rank"), tools: tools.length };
  } catch (e) {
    mcp = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const deep = new URL(request.url).searchParams.get("deep") === "1" && missingEnv.length === 0 ? await cachedDeep(sharedQlooMcp()) : undefined;
  const ok = missingEnv.length === 0 && mcp.ok && (deep?.ok ?? true);
  return Response.json({ ok, missingEnv, mcp, deep, audits: sharedAuditGate().usage() }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
