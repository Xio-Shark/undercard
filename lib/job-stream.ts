// Shared NDJSON streaming for live jobs (audit, veto). Owns the run gate, the heartbeat that keeps
// Cloudflare from closing an idle response (~100 s), abort on client disconnect, and error reporting.
import { sharedAuditGate } from "./limits";

export type Send = (event: object) => void;
export type Job = (ctx: { send: Send; signal: AbortSignal; started: number }) => Promise<void>;

export function streamJob(request: Request, job: Job, opts: { usesQloo?: boolean } = {}): Response {
  const gate = sharedAuditGate().tryAcquire(new Date(), { counts: opts.usesQloo ?? true });
  if (!gate.ok) {
    const status = gate.reason === "busy" ? 429 : 503;
    return Response.json({ error: gate.reason }, { status, headers: gate.reason === "busy" ? { "Retry-After": "30" } : {} });
  }
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(request.signal.reason), { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: Send = (event) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      const started = Date.now();
      const heartbeat = setInterval(() => send({ type: "heartbeat", ms: Date.now() - started }), 15_000);
      try {
        await job({ send, signal: abort.signal, started });
      } catch (e) {
        if (!abort.signal.aborted) send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        clearInterval(heartbeat);
        gate.release();
        try {
          controller.close();
        } catch {
          // already closed by a client disconnect
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
