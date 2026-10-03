"use client";
// "Ask Undercard" (T19): follow-up questions answered by an agent that calls Qloo tools. Shown under a live
// result (signed run state) and on shared briefs (signed share token). The agent explores; it never changes
// the audit, which only vetoes and reference edits do.
import { useRef, useState } from "react";
import type { AuditResult } from "@/lib/audit";
import { AuditHttpError, streamJob, type AskEvent, type AskRequestBody } from "@/lib/client/stream";

type Complete = Extract<AuditResult, { status: "complete" }>;
type Step = { tool: string; input: string; output: string; ok: boolean };
type Turn = { question: string; answer: string; trace: Step[]; notes: string[]; ms: number };

const TOOL_LABEL: Record<string, string> = {
  lookup_artist: "Looked up",
  rank_for_audience: "Ranked (exploratory)",
  compare_audiences: "Compared audiences",
};
const RANK_PROMPT = "How would this shortlist rank for fans of ";

/** Suggested questions built from this result, so each one needs a real decision or a Qloo call. */
export function suggestions(result: Complete): { label: string; question: string; prefill?: boolean }[] {
  const p = result.priority;
  const bestTarget = [...result.table].sort((a, b) => a.targetRank - b.targetRank)[0];
  const backup = result.backups[0];
  const out: { label: string; question: string; prefill?: boolean }[] = [];
  if (bestTarget && bestTarget.id !== p.id) out.push({ label: `Why not ${bestTarget.name}?`, question: `Why isn't ${bestTarget.name} the priority, if Qloo ranks them first for the target audience?` });
  if (backup) out.push({ label: `${p.name} vs ${backup.name}`, question: `What does ${backup.name}'s audience share with ${result.headliner.name}'s fans compared with ${p.name}?` });
  out.push({ label: "Try another audience…", question: RANK_PROMPT, prefill: true });
  return out;
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-1 text-xs">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2">
          <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${s.ok ? "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200" : "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200"}`}>Qloo</span>
          <span><strong className="font-medium">{TOOL_LABEL[s.tool] ?? s.tool}</strong> <span className="opacity-60">{s.input}</span> → {s.output}</span>
        </li>
      ))}
    </ol>
  );
}

export function AskPanel({ source, result }: { source: AskRequestBody["source"]; result: Complete }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [running, setRunning] = useState<{ question: string; steps: Step[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function ask(question: string) {
    const q = question.trim();
    if (q.length < 3 || running) return;
    setError(null);
    setText("");
    setRunning({ question: q, steps: [] });
    const history = turns.slice(-3).map((t) => ({ question: t.question, answer: t.answer }));
    let answered = false;
    try {
      await streamJob<AskEvent>("api/ask", { source, question: q, history }, (e) => {
        if (e.type === "tool") setRunning((r) => r && { ...r, steps: [...r.steps, e] });
        else if (e.type === "answer") {
          answered = true;
          setTurns((t) => [...t, { question: q, answer: e.answer, trace: e.trace, notes: e.notes, ms: e.ms }]);
        } else if (e.type === "error") setError(e.message);
      });
      if (!answered) setError((m) => m ?? "The connection closed before the agent answered.");
    } catch (e) {
      setError(e instanceof AuditHttpError && e.code === "busy" ? "A live audit or question is running for someone else. Try again in about 30 seconds." : e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-violet-500/40 p-5" aria-label="Ask Undercard">
      <div>
        <h3 className="text-lg font-semibold">Ask Undercard</h3>
        <p className="mt-1 text-sm opacity-75">
          A follow-up agent that decides which Qloo calls to make: look up another artist, rank this shortlist for a different audience, compare two audiences. It can explore; it cannot change the audit above.
        </p>
      </div>

      {turns.map((t, i) => (
        <div key={i} className="space-y-2 border-t border-black/10 pt-3 dark:border-white/10">
          <p className="text-sm font-medium">Q: {t.question}</p>
          <p className="text-sm leading-relaxed">{t.answer}</p>
          {t.trace.length > 0 ? (
            <details className="text-xs">
              <summary className="cursor-pointer opacity-70">Agent steps · {t.trace.length} Qloo call{t.trace.length > 1 ? "s" : ""} · {(t.ms / 1000).toFixed(0)} s</summary>
              <div className="mt-2"><Steps steps={t.trace} /></div>
            </details>
          ) : (
            <p className="text-xs opacity-60">Answered from the audit data; no new Qloo call was needed · {(t.ms / 1000).toFixed(0)} s</p>
          )}
          {t.notes.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-300">Qloo flagged: {t.notes.join("; ")}</p>}
        </div>
      ))}

      {running && (
        <div className="space-y-2 border-t border-black/10 pt-3 dark:border-white/10" aria-live="polite">
          <p className="text-sm font-medium">Q: {running.question}</p>
          <p className="text-xs opacity-70">Agent working…</p>
          <Steps steps={running.steps} />
        </div>
      )}
      {error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-200">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {suggestions(result).map((s) => (
          <button
            key={s.label}
            disabled={!!running}
            className="rounded-full border border-black/15 px-3 py-1 text-xs disabled:opacity-50 dark:border-white/20"
            onClick={() => {
              if (!s.prefill) return void ask(s.question);
              setText(s.question);
              inputRef.current?.focus();
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input
          ref={inputRef}
          value={text}
          maxLength={300}
          onChange={(e) => setText(e.target.value)}
          disabled={!!running}
          placeholder="Ask a follow-up, e.g. how would this list rank for fans of Billie Eilish?"
          className="min-w-0 flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
        />
        <button type="submit" disabled={!!running || text.trim().length < 3} className="rounded-md bg-violet-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Ask</button>
      </form>
    </section>
  );
}
