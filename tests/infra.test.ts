import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditGate } from "../lib/limits";
import { decodeShare, encodeShare } from "../lib/share";

describe("share tokens", () => {
  beforeEach(() => {
    process.env.SHARE_SECRET = "test-secret-test-secret-test-secret-123";
  });
  afterEach(() => {
    delete process.env.SHARE_SECRET;
  });

  it("round-trips a payload", () => {
    const payload = { priority: "Lucy Dacus", ranks: [1, 3], note: "Affinity is not ticket demand." };
    expect(decodeShare(encodeShare(payload))).toEqual(payload);
  });

  it("rejects a tampered body", () => {
    const [v, body, mac] = encodeShare({ priority: "Lucy Dacus" }).split(".");
    const forged = `${v}.${encodeShare({ priority: "Gracie Abrams" }).split(".")[1]}.${mac}`;
    expect(body).not.toBe(forged.split(".")[1]);
    expect(() => decodeShare(forged)).toThrow(/signature/);
  });

  it("rejects tokens signed with another secret", () => {
    const token = encodeShare({ a: 1 });
    process.env.SHARE_SECRET = "another-secret-another-secret-another-1";
    expect(() => decodeShare(token)).toThrow(/signature/);
  });

  it("refuses to run without a strong secret", () => {
    process.env.SHARE_SECRET = "short";
    expect(() => encodeShare({})).toThrow(/SHARE_SECRET/);
  });
});

describe("audit gate", () => {
  const day1 = new Date("2026-10-03T10:00:00Z");

  it("allows one audit at a time", () => {
    const gate = createAuditGate(10);
    const first = gate.tryAcquire(day1);
    expect(first.ok).toBe(true);
    expect(gate.tryAcquire(day1)).toEqual({ ok: false, reason: "busy" });
    if (first.ok) first.release();
    expect(gate.tryAcquire(day1).ok).toBe(true);
  });

  it("enforces the daily cap and resets on a new UTC day", () => {
    const gate = createAuditGate(2);
    for (let i = 0; i < 2; i++) {
      const g = gate.tryAcquire(day1);
      if (g.ok) g.release();
    }
    expect(gate.tryAcquire(day1)).toEqual({ ok: false, reason: "daily_limit" });
    expect(gate.tryAcquire(new Date("2026-10-04T00:00:01Z")).ok).toBe(true);
  });

  it("ignores double release", () => {
    const gate = createAuditGate(5);
    const g = gate.tryAcquire(day1);
    if (g.ok) {
      g.release();
      g.release();
    }
    expect(gate.usage(day1).running).toBe(0);
  });
});

describe("gate: jobs without Qloo calls", () => {
  it("are serialized but do not use the daily Qloo budget", () => {
    const gate = createAuditGate(1);
    const now = new Date("2026-10-03T12:00:00Z");
    const a = gate.tryAcquire(now);
    expect(a.ok).toBe(true);
    expect(gate.tryAcquire(now, { counts: false })).toEqual({ ok: false, reason: "busy" });
    if (a.ok) a.release();
    const b = gate.tryAcquire(now, { counts: false });
    expect(b.ok).toBe(true);
    expect(gate.usage(now).usedToday).toBe(1);
    if (b.ok) b.release();
    expect(gate.tryAcquire(now)).toEqual({ ok: false, reason: "daily_limit" });
  });
});
