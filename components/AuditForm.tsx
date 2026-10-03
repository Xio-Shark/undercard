"use client";
// Input form: headliner, 1-3 target references, 2-10 shortlist names, the team's question, presets.
import { useState } from "react";
import { PRESETS } from "./presets";

export interface FormValues {
  headliner: string;
  references: string;
  shortlist: string;
  question: string;
  hypothetical: boolean;
}

export const EMPTY_FORM: FormValues = { headliner: "", references: "", shortlist: "", question: "", hypothetical: false };

export const splitNames = (s: string) =>
  s
    .split(/\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);

export function validate(v: FormValues): string | null {
  const refs = splitNames(v.references);
  const list = splitNames(v.shortlist);
  if (!v.headliner.trim()) return "Add the headliner.";
  if (refs.length < 1 || refs.length > 3) return "Use 1–3 target audience reference artists.";
  if (list.length < 2 || list.length > 10) return "The shortlist needs 2–10 acts.";
  if (!v.hypothetical) return "Confirm the booking-feasibility checkbox first.";
  return null;
}

const field = "mt-1 w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20";

export function AuditForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: (v: FormValues) => void }) {
  const [v, setV] = useState<FormValues>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormValues>) => setV((cur) => ({ ...cur, ...patch }));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const problem = validate(v);
        setError(problem);
        if (!problem) onSubmit(v);
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="opacity-70">Try a case:</span>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={disabled}
            onClick={() => set({ headliner: p.headliner, references: p.references.join("\n"), shortlist: p.shortlist.join("\n"), question: p.question, hypothetical: true })}
            className="rounded-full border border-black/15 px-3 py-1 hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:hover:bg-white/10"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm font-medium">
          Headliner
          <input className={field} value={v.headliner} onChange={(e) => set({ headliner: e.target.value })} placeholder="e.g. Phoebe Bridgers" />
        </label>
        <label className="block text-sm font-medium">
          Target audience references <span className="font-normal opacity-60">(1–3, one per line)</span>
          <textarea className={field} rows={3} value={v.references} onChange={(e) => set({ references: e.target.value })} placeholder="Artists whose fans you want to reach" />
        </label>
      </div>
      <label className="block text-sm font-medium">
        Shortlist <span className="font-normal opacity-60">(2–10 pre-screened acts, one per line)</span>
        <textarea className={field} rows={5} value={v.shortlist} onChange={(e) => set({ shortlist: e.target.value })} />
      </label>
      <label className="block text-sm font-medium">
        What should the audit answer? <span className="font-normal opacity-60">(optional)</span>
        <textarea className={field} rows={2} value={v.question} onChange={(e) => set({ question: e.target.value })} />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={v.hypothetical} onChange={(e) => set({ hypothetical: e.target.checked })} />
        <span>My team checks fees, dates and willingness separately — or this is a hypothetical demo case.</span>
      </label>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button type="submit" disabled={disabled} className="rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
        Audit shortlist
      </button>
    </form>
  );
}
