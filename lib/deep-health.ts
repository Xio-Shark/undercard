// Deep health check (T19 monitoring): proves both keys still work during judging, which tools/list cannot.
// One qloo_describe (1-2 Qloo requests; the harness resolution cache lasts 15 min, so a check 6 h later
// reaches the API) and one tiny model call. The result is cached for CACHE_MS so a public URL cannot be
// used to drain the Qloo budget: at most 4 checks a day.
import { generateText } from "ai";
import { chatModel } from "./llm";
import type { QlooCaller } from "./audit";

export const CACHE_MS = 6 * 60 * 60 * 1000;

export interface DeepHealth {
  ok: boolean;
  checkedAt: string;
  qloo: { ok: boolean; error?: string };
  llm: { ok: boolean; error?: string };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function checkDeep(mcp: QlooCaller, ping: () => Promise<string> = pingModel): Promise<DeepHealth> {
  const [qloo, llm] = await Promise.all([
    mcp.call("qloo_describe", { entity: "Phoebe Bridgers", type: "artist" }).then(
      (out) => (out.status === "ok" ? { ok: true } : { ok: false, error: `qloo_describe returned ${String(out.status)}: ${JSON.stringify(out.error ?? {})}` }),
      (e) => ({ ok: false, error: message(e) }),
    ),
    ping().then(
      (text) => (text.trim() ? { ok: true } : { ok: false, error: "empty model reply" }),
      (e) => ({ ok: false, error: message(e) }),
    ),
  ]);
  return { ok: qloo.ok && llm.ok, checkedAt: new Date().toISOString(), qloo, llm };
}

// deepseek-flash reasons before answering; a 16-token cap returned empty text, so the cap leaves room for that.
async function pingModel(): Promise<string> {
  const { text } = await generateText({ model: chatModel(), prompt: "Reply with the word OK.", maxOutputTokens: 256 });
  return text;
}

const globalForDeep = globalThis as unknown as { undercardDeepHealth?: { at: number; value: Promise<DeepHealth> } };

/** Cached result; a failed check is cached too, so a broken key is reported, not retried on every request. */
export function cachedDeep(mcp: QlooCaller, now = Date.now()): Promise<DeepHealth> {
  const hit = globalForDeep.undercardDeepHealth;
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const value = checkDeep(mcp);
  globalForDeep.undercardDeepHealth = { at: now, value };
  return value;
}
