"use client";
// Single-page flow: form -> live progress -> (confirm ambiguous names | handle partial) -> result
// -> veto (original-pool rerank) / edit references (new query) -> decision -> share.
import { useEffect, useRef, useState } from "react";
import type { AuditResult } from "@/lib/audit";
import type { Brief } from "@/lib/llm";
import type { RunContext } from "@/lib/replan";
import { AuditHttpError, createShareLink, streamJob, type AuditRequestBody, type Decision, type VetoRequestBody } from "@/lib/client/stream";
import { AuditForm, splitNames, type FormValues } from "./AuditForm";
import { loadRun, saveRun } from "@/lib/client/tab-memory";
import { AskPanel } from "./AskPanel";
import { ConfirmMatches } from "./ConfirmMatches";
import { ChangeSummary, ResultView } from "./ResultView";
import { DecisionBar, EditReferences, VetoControl } from "./RunControls";

type Complete = Extract<AuditResult, { status: "complete" }>;
type Pending = Exclude<AuditResult, { status: "complete" }>;
type Done = { phase: "complete"; result: Complete; brief: Brief; priorityKept: boolean; ms: number; context: RunContext; token: string; restored?: boolean; briefAttempts?: number };
type Remembered = { state: Done | { phase: "empty"; context: RunContext }; request: AuditRequestBody };
const isRemembered = (v: unknown): v is Remembered => {
  const r = v as Remembered | null;
  return !!r?.request && (r.state?.phase === "complete" || r.state?.phase === "empty");
};
type State =
  | { phase: "idle" }
  | { phase: "running"; title: string; steps: string[]; startedAt: number }
  | { phase: "stopped"; result: Pending }
  | Done
  | { phase: "empty"; context: RunContext }
  | { phase: "error"; message: string; back?: Done };

const STEP_LABEL: Record<string, string> = {
  resolve: "Resolving names with Qloo",
  rank: "Ranking the same shortlist",
  compare: "Comparing audiences for the priority",
  brief: "Writing the brief from the evidence",
};
const QUERY_TITLE = "Live audit running… this usually takes 30–60 seconds.";

export function AuditApp() {
  const [state, setState] = useState<State>({ phase: "idle" });
  const [request, setRequest] = useState<AuditRequestBody | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [share, setShare] = useState<{ url?: string; error?: string; busy?: boolean }>({});
  const abortRef = useRef<AbortController | null>(null);
  const outcomeRef = useRef<HTMLDivElement | null>(null);

  // A refresh restores this tab's last finished run (saved results are never re-queried).
  useEffect(() => {
    const last = loadRun(isRemembered);
    if (!last) return;
    // One-time sync from browser-only storage after hydration; reading it during render would mismatch the server HTML.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRequest(last.request);
    setState(last.state.phase === "complete" ? { ...last.state, restored: true } : last.state);
  }, []);
  useEffect(() => {
    if ((state.phase === "complete" && !state.restored) || state.phase === "empty") {
      if (request) saveRun<Remembered>({ state, request });
    }
  }, [state, request]);

  // On phones the outcome renders below the form; bring it into view when it changes.
  useEffect(() => {
    if (state.phase !== "idle") outcomeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [state.phase]);

  /** One live job (query or veto). `back` is the result to return to if a veto fails. */
  async function run(job: { path: "api/audit"; body: AuditRequestBody } | { path: "api/veto"; body: VetoRequestBody; title: string; back: Done }) {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    const back = job.path === "api/veto" ? job.back : undefined;
    if (job.path === "api/audit") setRequest(job.body);
    setDecision(null);
    setShare({});
    setState({ phase: "running", title: job.path === "api/veto" ? job.title : QUERY_TITLE, steps: [], startedAt: Date.now() });
    try {
      await streamJob(
        job.path,
        job.body,
        (e) => {
          if (e.type === "progress") {
            const label = `${STEP_LABEL[e.step] ?? e.step}${e.detail ? ` — ${e.detail}` : ""}`;
            setState((s) => (s.phase === "running" ? { ...s, steps: [...s.steps, label] } : s));
          } else if (e.type === "result" && e.result.status === "complete" && "brief" in e) {
            setState({ phase: "complete", result: e.result, brief: e.brief, priorityKept: e.priorityKept, ms: e.ms, context: e.context, token: e.state, briefAttempts: e.model?.attempts });
          } else if (e.type === "result" && e.result.status !== "complete") {
            setState({ phase: "stopped", result: e.result });
          } else if (e.type === "empty") {
            setState({ phase: "empty", context: e.context });
          } else if (e.type === "error") {
            setState({ phase: "error", message: e.message, back });
          }
        },
        abort.signal,
      );
      setState((s) => (s.phase === "running" ? { phase: "error", message: "The connection closed before a result arrived.", back } : s));
    } catch (e) {
      if (abort.signal.aborted) return;
      setState({ phase: "error", message: e instanceof AuditHttpError || e instanceof Error ? e.message : String(e), back });
    }
  }

  const query = (body: AuditRequestBody) => void run({ path: "api/audit", body });

  const fromForm = (v: FormValues): AuditRequestBody => ({
    headliner: v.headliner.trim(),
    references: splitNames(v.references),
    shortlist: splitNames(v.shortlist),
    question: v.question.trim() || undefined,
  });

  async function saveAndShare() {
    if (state.phase !== "complete" || !request) return;
    setShare({ busy: true });
    try {
      const input = { ...request };
      delete input.previous;
      const url = await createShareLink({ version: 1, savedAt: new Date().toISOString(), input, result: state.result, brief: state.brief, context: state.context, decision: decision ?? undefined });
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      setShare({ url });
    } catch (e) {
      setShare({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  const running = state.phase === "running";
  return (
    <div className="space-y-8">
      <AuditForm disabled={running} onSubmit={(v) => query(fromForm(v))} />

      <div ref={outcomeRef} className="scroll-mt-4" />
      {running && (
        <div className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/15" aria-live="polite">
          <p className="font-medium">{state.title}</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 opacity-80">{state.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          <button className="mt-3 text-xs underline" onClick={() => { abortRef.current?.abort(); setState({ phase: "idle" }); }}>Cancel</button>
        </div>
      )}

      {state.phase === "error" && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-200">
          <p>{state.message}</p>
          {state.back && <button className="mt-2 underline" onClick={() => setState(state.back!)}>Back to the last result (the veto was not applied)</button>}
        </div>
      )}

      {state.phase === "empty" && (
        <div className="space-y-3">
          <ChangeSummary context={state.context} />
          <p className="rounded-md bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
            Every act in this pool of {state.context.originalPoolSize} is vetoed, so there is no priority. Vetoes are not undone automatically: edit the shortlist above and run a new query when the team has new options.
          </p>
        </div>
      )}

      {state.phase === "stopped" && state.result.status === "needs_input" && request && (
        <ConfirmMatches request={request} ambiguous={state.result.ambiguous} onRun={query} />
      )}

      {state.phase === "stopped" && state.result.status === "partial" && request && (
        <div className="space-y-3 rounded-lg border border-amber-400/60 p-4 text-sm">
          <p className="font-medium">Partial: Qloo returned no rank for {state.result.missing.join(", ")} on at least one side, so no priority is given for this pool of {state.result.poolSize}.</p>
          <p className="opacity-80">You can remove the unranked acts and run a new query. The new pool is a different comparison; its ranks are not comparable with this one.</p>
          <button
            className="rounded-md border border-black/20 px-3 py-1.5 font-semibold dark:border-white/25"
            onClick={() => {
              const drop = new Set((state.result as Extract<Pending, { status: "partial" }>).missingInputs);
              query({ ...request, shortlist: request.shortlist.filter((n) => !drop.has(n)) });
            }}
          >
            Remove {state.result.missingInputs.join(", ")} and run a new query
          </button>
        </div>
      )}

      {state.phase === "stopped" && state.result.status === "invalid_pool" && (
        <p className="rounded-md bg-amber-50 p-3 text-sm dark:bg-amber-950/40">{state.result.reason} Removed: {state.result.excluded.join(", ") || "—"}.</p>
      )}

      {state.phase === "complete" && request && (
        <div className="space-y-6">
          <p className="text-xs opacity-60">{state.restored ? "Restored from this tab after a refresh (not re-queried)" : `Live run · ${(state.ms / 1000).toFixed(0)} s`}{state.priorityKept ? "" : " · note: the brief named a different priority than the rule; the rule's choice is shown"}{(state.briefAttempts ?? 1) > 1 ? " · the model's first brief was malformed and was regenerated once" : ""}</p>
          <ResultView
            result={state.result}
            brief={state.brief}
            context={state.context}
            rowAction={(row) => (
              <VetoControl
                row={row}
                disabled={running}
                onVeto={(veto) => void run({ path: "api/veto", body: { state: state.token, veto }, title: `Vetoing ${row.name} — original-pool rerank, no new ranking…`, back: state })}
              />
            )}
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-black/10 pt-4 text-sm dark:border-white/10">
            <DecisionBar priority={state.result.priority.name} decision={decision} onDecide={setDecision} />
            <button className="rounded-md bg-violet-600 px-3 py-1.5 font-semibold text-white disabled:opacity-50" disabled={share.busy} onClick={() => void saveAndShare()}>
              Save brief &amp; copy share link
            </button>
            <EditReferences current={request.references} question={request.question} disabled={running} onRun={(edit) => query({ ...request, ...edit, previous: state.token })} />
          </div>
          {decision && <p className="text-sm">Decision recorded: {decision.kind === "accepted" ? `evaluate ${state.result.priority.name} first` : `no selection${decision.reason ? ` — ${decision.reason}` : ""}`}. The team keeps the final booking decision.</p>}
          {share.url && <p className="break-all text-sm">Read-only link (copied): <a className="underline" href={share.url}>{share.url}</a></p>}
          {share.error && <p className="text-sm text-red-600">{share.error}</p>}
          <AskPanel key={state.token} source={{ kind: "state", token: state.token }} result={state.result} />
        </div>
      )}
    </div>
  );
}
