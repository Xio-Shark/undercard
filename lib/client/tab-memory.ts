// Per-tab memory of the last finished run, so a refresh does not lose it. sessionStorage only: it stays
// in this tab, is never shared, and may be unavailable (private mode, blocked storage) — then nothing is kept.
const KEY = "undercard:last-run:v1";

export function saveRun<T>(value: T): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable or full: refresh recovery is a convenience; the live result is unaffected.
  }
}

export function loadRun<T>(isValid: (v: unknown) => v is T): T | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return isValid(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearRun(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // see saveRun
  }
}
