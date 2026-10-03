// POST /api/share {payload} -> {token}; GET /api/share?t=<token> -> {payload}.
// Tokens are signed server-side, so a shared link cannot be edited into a fake Qloo-backed brief.
import { decodeShare, encodeShare } from "@/lib/share";

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => undefined)) as { payload?: unknown } | undefined;
  if (!body || body.payload === undefined) return Response.json({ error: "payload required" }, { status: 400 });
  try {
    return Response.json({ token: encodeShare(body.payload) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 413 });
  }
}

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t");
  if (!token) return Response.json({ error: "t required" }, { status: 400 });
  try {
    return Response.json({ payload: decodeShare(token) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
