"use client";
// Ambiguous names: the user picks the Qloo entity they mean, or says none of them is right.
import { useState } from "react";
import type { Choice } from "@/lib/audit";
import { applyMatchChoices, NONE } from "@/lib/client/matches";
import type { AuditRequestBody } from "@/lib/client/stream";

export function ConfirmMatches({ request, ambiguous, onRun }: { request: AuditRequestBody; ambiguous: { input: string; role: string; choices: Choice[] }[]; onRun: (body: AuditRequestBody) => void }) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const outcome = applyMatchChoices(request, ambiguous, choices);
  const pick = (input: string, id: string) => setChoices((m) => ({ ...m, [input]: id }));
  return (
    <div className="space-y-3 rounded-lg border border-amber-400/60 p-4">
      <p className="text-sm font-medium">Some names match more than one Qloo entity. Pick the one you mean — nothing is chosen automatically.</p>
      {ambiguous.map((a) => (
        <fieldset key={a.input} className="text-sm">
          <legend className="font-semibold">“{a.input}” <span className="font-normal opacity-60">({a.role})</span></legend>
          {a.choices.map((c) => (
            <label key={c.id} className="mt-1 flex items-start gap-2">
              <input type="radio" name={a.input} checked={choices[a.input] === c.id} onChange={() => pick(a.input, c.id)} className="mt-1" />
              <span><strong>{c.name}</strong>{c.description ? ` — ${c.description}` : ""}</span>
            </label>
          ))}
          <label className="mt-1 flex items-start gap-2 opacity-80">
            <input type="radio" name={a.input} checked={choices[a.input] === NONE} onChange={() => pick(a.input, NONE)} className="mt-1" />
            <span>None of these{a.role === "candidate" ? " — Qloo does not have this act; remove it from the shortlist" : " — I will edit the name"}</span>
          </label>
        </fieldset>
      ))}
      {"error" in outcome && Object.keys(choices).length > 0 && <p className="text-sm text-amber-800 dark:text-amber-300">{outcome.error}</p>}
      <button
        className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        disabled={"error" in outcome}
        onClick={() => "body" in outcome && onRun(outcome.body)}
      >
        {"body" in outcome && outcome.removed.length ? `Remove ${outcome.removed.join(", ")} and continue (new query)` : "Continue with these matches"}
      </button>
    </div>
  );
}
