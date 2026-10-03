"use client";
// Feedback controls on a live result: veto one act (original-pool rerank), edit target references
// (new query), and record the team's decision. Each action names what it will do before it runs.
import { useState } from "react";
import type { RankRow } from "@/lib/audit";
import type { Decision } from "@/lib/client/stream";
import { VETO_LABEL, VETO_REASONS, type VetoReason } from "@/lib/replan";
import { splitNames } from "./AuditForm";

const button = "rounded-md border border-black/20 px-3 py-1.5 text-sm font-semibold disabled:opacity-50 dark:border-white/25";
const input = "rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20";

export function VetoControl({ row, disabled, onVeto }: { row: RankRow; disabled: boolean; onVeto: (v: { id: string; reason: VetoReason; note?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<VetoReason | "">("");
  const [note, setNote] = useState("");
  if (!open) {
    return <button className="text-xs underline disabled:opacity-40" disabled={disabled} onClick={() => setOpen(true)} aria-label={`Veto ${row.name}`}>Veto</button>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs font-normal">
      <select className={input} value={reason} onChange={(e) => setReason(e.target.value as VetoReason)} aria-label={`Reason to veto ${row.name}`}>
        <option value="">Reason…</option>
        {VETO_REASONS.map((r) => <option key={r} value={r}>{VETO_LABEL[r]}</option>)}
      </select>
      <input className={`${input} w-32`} maxLength={200} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Veto note" />
      <button className="rounded bg-slate-700 px-2 py-1 font-semibold text-white disabled:opacity-40" disabled={disabled || !reason} onClick={() => reason && onVeto({ id: row.id, reason, note: note.trim() || undefined })}>
        Veto {row.name}
      </button>
      <button className="underline" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

export function EditReferences({ current, question, disabled, onRun }: { current: string[]; question?: string; disabled: boolean; onRun: (edit: { references: string[]; question?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(current.join("\n"));
  const [q, setQ] = useState(question ?? "");
  const refs = splitNames(text);
  const changed = refs.join("\n") !== current.join("\n");
  const valid = refs.length >= 1 && refs.length <= 3;
  // The brief answers the question as written, so a question still naming a dropped reference would mislead it.
  const stale = current.filter((r) => !refs.includes(r) && q.toLowerCase().includes(r.toLowerCase()));
  if (!open) return <button className={button} disabled={disabled} onClick={() => setOpen(true)}>Edit target references</button>;
  return (
    <div className="w-full space-y-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
      <label className="block font-medium">
        Target audience references <span className="font-normal opacity-60">(1–3, one per line)</span>
        <textarea className={`${input} mt-1 block w-full`} rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="block font-medium">
        Question for the brief <span className="font-normal opacity-60">(optional)</span>
        <textarea className={`${input} mt-1 block w-full`} rows={2} maxLength={600} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {stale.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-300">The question still mentions {stale.join(", ")}, which is no longer a reference. Update it so the brief answers the right question.</p>}
      <p className="text-xs opacity-70">This runs a new Qloo query on the same shortlist. Vetoed acts stay out. The new ranks are a different comparison and are not comparable with this run.</p>
      {!valid && <p className="text-xs text-red-600">Use 1–3 reference artists.</p>}
      <div className="flex gap-2">
        <button className={button} disabled={disabled || !valid || !changed} onClick={() => onRun({ references: refs, question: q.trim() || undefined })}>Run new query</button>
        <button className="text-xs underline" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export function DecisionBar({ priority, decision, onDecide }: { priority: string; decision: Decision | null; onDecide: (d: Decision) => void }) {
  const [askingReason, setAskingReason] = useState(false);
  const [reason, setReason] = useState("");
  const active = (kind: Decision["kind"]) => decision?.kind === kind;
  return (
    <>
      <button className={`${button} ${active("accepted") ? "border-violet-600 bg-violet-600 text-white" : ""}`} onClick={() => { setAskingReason(false); onDecide({ kind: "accepted" }); }}>
        Accept {priority} for review
      </button>
      <button className={`${button} ${active("no_selection") ? "border-slate-700 bg-slate-700 text-white" : ""}`} onClick={() => setAskingReason(true)}>
        No selection
      </button>
      {askingReason && (
        <span className="flex w-full flex-wrap items-center gap-2">
          <input className={`${input} min-w-0 flex-1`} maxLength={200} placeholder="Why no selection? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className={button} onClick={() => { onDecide({ kind: "no_selection", reason: reason.trim() || undefined }); setAskingReason(false); }}>Record no selection</button>
        </span>
      )}
    </>
  );
}
