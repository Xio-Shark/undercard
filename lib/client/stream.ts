// Browser-side reader for POST /api/audit and /api/veto (NDJSON). Pure fetch; safe for client components.
import type { AuditResult } from "../audit";
import type { Brief } from "../llm";
import type { RunContext, VetoReason } from "../replan";

export interface AuditRequestBody {
  headliner: string;
  references: string[];
  shortlist: string[];
  confirmations?: Record<string, string>;
  question?: string;
  language?: "English" | "Chinese";
  /** Signed state of the run being edited; set for a re-query after editing references. */
  previous?: string;
}

export interface VetoRequestBody {
  state: string;
  veto: { id: string; reason: VetoReason; note?: string };
}

/** Follow-up question about a finished run: `source` is its signed live state (s1) or a shared brief (v1). */
export interface AskRequestBody {
  source: { kind: "state" | "share"; token: string };
  question: string;
  history?: { question: string; answer: string }[];
}

export type AskEvent =
  | { type: "tool"; tool: string; input: string; output: string; ok: boolean }
  | { type: "heartbeat"; ms: number }
  | { type: "answer"; answer: string; trace: { tool: string; input: string; output: string; ok: boolean }[]; notes: string[]; ms: number }
  | { type: "error"; message: string };

export type AuditEvent =
  | { type: "progress"; step: string; detail?: string; ms: number }
  | { type: "heartbeat"; ms: number }
  | { type: "result"; result: Exclude<AuditResult, { status: "complete" }>; ms: number }
  | { type: "result"; result: Extract<AuditResult, { status: "complete" }>; brief: Brief; priorityKept: boolean; context: RunContext; state: string; ms: number; model?: { attempts: number } }
  | { type: "empty"; context: RunContext; state: string; ms: number }
  | { type: "error"; message: string };

export class AuditHttpError extends Error {
  constructor(public status: number, public code: string) {
    super(
      code === "busy" ? "Another live audit is running. Try again in about 30 seconds."
        : code === "daily_limit" ? "Today's live audit limit is reached. Saved runs still work."
        : code === "invalid_state" ? "This run can no longer be edited (its signed state is invalid). Run a new query."
        : code === "not_in_pool" ? "That act is no longer in the current pool."
        : `Request failed (${status}: ${code})`,
    );
  }
}

/** Streams job events to `onEvent`; resolves when the server closes the stream. */
export async function streamJob<E = AuditEvent>(path: "api/audit" | "api/veto" | "api/ask", body: AuditRequestBody | VetoRequestBody | AskRequestBody, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new AuditHttpError(res.status, err.error ?? "unknown");
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as E);
    }
  }
}

export type Decision = { kind: "accepted" | "no_selection"; reason?: string };

export interface SavedBrief {
  version: 1;
  savedAt: string;
  input: Omit<AuditRequestBody, "previous">;
  result: Extract<AuditResult, { status: "complete" }>;
  brief: Brief;
  /** Vetoes, labels and latest change; absent in links saved before T09. */
  context?: RunContext;
  decision?: Decision;
}

export async function createShareLink(payload: SavedBrief): Promise<string> {
  const res = await fetch("api/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(body.error ?? `Share failed (${res.status})`);
  return new URL(`b?t=${body.token}`, window.location.href).toString();
}
