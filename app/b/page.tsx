// Read-only view of a saved brief. The link carries the brief, signed server-side (lib/share.ts).
import Link from "next/link";
import { ResultView } from "@/components/ResultView";
import type { SavedBrief } from "@/lib/client/stream";
import { decodeShare } from "@/lib/share";

export default async function SharedBrief({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const t = (await searchParams).t;
  let saved: SavedBrief | null = null;
  let problem: string | null = null;
  if (typeof t !== "string") problem = "This link has no saved brief.";
  else {
    try {
      saved = decodeShare<SavedBrief>(t);
    } catch {
      problem = "This link is invalid or was modified, so it cannot be shown as a Qloo-backed brief.";
    }
  }
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-400">Undercard · shared brief (read-only)</p>
      {problem || !saved ? (
        <p className="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-200">{problem}</p>
      ) : (
        <div className="mt-4 space-y-6">
          <h1 className="text-2xl font-bold">
            {saved.input.headliner} → {saved.input.references.join(", ")}
          </h1>
          {saved.input.question && <p className="text-sm opacity-80">Question: {saved.input.question}</p>}
          {saved.decision && (
            <p className="rounded-md bg-black/5 p-3 text-sm dark:bg-white/10">
              Team decision: {saved.decision.kind === "accepted" ? `evaluate ${saved.result.priority.name} first` : `no selection${saved.decision.reason ? ` — ${saved.decision.reason}` : ""}`}
            </p>
          )}
          <ResultView result={saved.result} brief={saved.brief} savedAt={saved.savedAt} context={saved.context} />
        </div>
      )}
      <p className="mt-10 text-sm"><Link className="underline" href="/">Run your own audit</Link></p>
    </main>
  );
}
