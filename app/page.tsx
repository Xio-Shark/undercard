import { AuditApp } from "@/components/AuditApp";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <header className="mb-8 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-400">Undercard</p>
        <h1 className="text-3xl font-bold">Audit your support-act shortlist against two audiences.</h1>
        <p className="max-w-2xl text-sm leading-relaxed opacity-80">
          Give the headliner, 1–3 artists whose fans you want to reach, and the acts you are already considering. Undercard ranks the same
          shortlist for both audiences with Qloo, suggests which act to review first by a fixed rule (the best rank on its weaker side), and
          explains what the evidence does and does not show. Your team makes the call.
        </p>
      </header>
      <AuditApp />
      <footer className="mt-16 border-t border-black/10 pt-4 text-xs opacity-60 dark:border-white/10">
        Relative taste affinity is not ticket demand or booking feasibility. Artists Qloo cannot find or rank are flagged, never guessed. Demo cases are hypothetical and use public artists. Powered by the Qloo Taste AI™ API.
      </footer>
    </main>
  );
}
