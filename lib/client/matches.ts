// Turns the user's answers to ambiguous names into the next query. "None of these" is a real answer:
// an unmatched candidate leaves the shortlist (the user says Qloo does not have that act); an unmatched
// headliner or reference cannot be dropped, so the user must edit the name instead.
import type { AuditRequestBody } from "./stream";

export const NONE = "none";
export type Ambiguous = { input: string; role: string };

export function applyMatchChoices(request: AuditRequestBody, ambiguous: Ambiguous[], choices: Record<string, string>): { body: AuditRequestBody; removed: string[] } | { error: string } {
  if (ambiguous.some((a) => !choices[a.input])) return { error: "Answer every name first." };
  const unmatched = ambiguous.filter((a) => choices[a.input] === NONE);
  const fixed = unmatched.filter((a) => a.role !== "candidate");
  if (fixed.length) return { error: `${fixed.map((a) => `“${a.input}”`).join(", ")} must match a Qloo entity: edit the name in the form above and run again.` };
  const removed = unmatched.map((a) => a.input);
  const shortlist = request.shortlist.filter((n) => !removed.includes(n));
  if (shortlist.length < 2) return { error: "Removing the unmatched acts leaves fewer than 2 candidates. Add acts in the form above." };
  const confirmations = { ...request.confirmations };
  for (const a of ambiguous) if (choices[a.input] !== NONE) confirmations[a.input] = choices[a.input];
  return { body: { ...request, shortlist, confirmations }, removed };
}
