// Run limits for the public deployment: one live audit at a time (Qloo allows 5 req/s and one audit
// already paces its own calls) and a daily cap that protects the 10,000 req/month Qloo budget
// (~40-50 requests per audit). Counters are in-process; a restart resets them, which is acceptable
// for a single-container deployment and is stated in the evidence.

export interface AuditGate {
  /** Returns a release function, or the reason the audit cannot start now. */
  /** `counts: false` = a job that makes no Qloo calls: still one-at-a-time, but outside the daily Qloo budget. */
  tryAcquire(now?: Date, opts?: { counts?: boolean }): { ok: true; release: () => void } | { ok: false; reason: "busy" | "daily_limit" };
  usage(now?: Date): { running: number; usedToday: number; dailyLimit: number };
}

export function createAuditGate(dailyLimit: number, maxConcurrent = 1): AuditGate {
  let running = 0;
  let day = "";
  let used = 0;
  const roll = (now: Date) => {
    const d = now.toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      used = 0;
    }
  };
  return {
    tryAcquire(now = new Date(), { counts = true } = {}) {
      roll(now);
      if (counts && used >= dailyLimit) return { ok: false, reason: "daily_limit" };
      if (running >= maxConcurrent) return { ok: false, reason: "busy" };
      running++;
      if (counts) used++;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          running--;
        },
      };
    },
    usage(now = new Date()) {
      roll(now);
      return { running, usedToday: used, dailyLimit };
    },
  };
}

const globalForGate = globalThis as unknown as { undercardAuditGate?: AuditGate };

export function sharedAuditGate(): AuditGate {
  globalForGate.undercardAuditGate ??= createAuditGate(Number(process.env.AUDIT_DAILY_LIMIT ?? 60));
  return globalForGate.undercardAuditGate;
}
