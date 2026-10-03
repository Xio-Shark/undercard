// T14 end-to-end check against a deployed Undercard (default: production). Uses only public HTTP endpoints.
// Run: pnpm e2e [baseUrl]. Spends Qloo quota: 2 audits + 1 priority veto (about 60-80 Qloo requests).
// Each step prints PASS/FAIL with the observed value; the process exits 1 if any step fails.
const BASE = (process.argv[2] ?? "https://undercard.wangbohan.biz").replace(/\/$/, "");
const CASE = { headliner: "Phoebe Bridgers", references: ["Olivia Rodrigo"], shortlist: ["Clairo", "Soccer Mommy", "Julien Baker"] };

type Json = Record<string, unknown>;
let failures = 0;
function check(name: string, ok: boolean, detail: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${BASE}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
const usage = async () => ((await (await fetch(`${BASE}/api/health`)).json()) as { audits: { running: number; usedToday: number } }).audits;

/** Reads an NDJSON job stream to its end; returns the events. `stopAfter` aborts once that many progress events arrived. */
async function readJob(res: Response, abort?: { controller: AbortController; stopAfter: number }): Promise<Json[]> {
  const events: Json[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        events.push(JSON.parse(line) as Json);
        if (abort && events.filter((e) => e.type === "progress").length >= abort.stopAfter) {
          abort.controller.abort();
          return events;
        }
      }
    }
  } catch (e) {
    if (!abort?.controller.signal.aborted) throw e;
  }
  return events;
}

async function waitIdle(ms = 20_000): Promise<number> {
  const until = Date.now() + ms;
  for (;;) {
    const u = await usage();
    if (u.running === 0 || Date.now() > until) return u.running;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function staticAndValidation(): Promise<void> {
  const home = await fetch(`${BASE}/`);
  check("home page", home.status === 200, home.status);
  const health = (await (await fetch(`${BASE}/api/health`)).json()) as Json;
  check("health: env + MCP tools", health.ok === true && (health.mcp as Json)?.ok === true, health);
  const bad = await post("api/audit", { headliner: "", references: [], shortlist: ["a"] });
  check("invalid audit input -> 400", bad.status === 400, bad.status);
  const forged = await post("api/veto", { state: "s1.AAAA.BBBB", veto: { id: "x", reason: "fee" } });
  check("forged run state -> 400 invalid_state", forged.status === 400 && ((await forged.json()) as Json).error === "invalid_state", forged.status);
}

async function busyAndCancel(): Promise<void> {
  const controller = new AbortController();
  const first = await post("api/audit", CASE, controller.signal);
  check("first audit starts", first.status === 200, first.status);
  const second = await post("api/audit", CASE);
  check("concurrent audit -> 429 busy", second.status === 429, second.status);
  await second.body?.cancel();
  const events = await readJob(first, { controller, stopAfter: 2 });
  check("cancel after 2 progress events", controller.signal.aborted, events.map((e) => e.type));
  const running = await waitIdle();
  check("gate released after client cancel", running === 0, `running=${running}`);
}

async function fullFlow(): Promise<void> {
  const before = await usage();
  const t0 = Date.now();
  const events = await readJob(await post("api/audit", CASE));
  const result = events.find((e) => e.type === "result") as Json | undefined;
  const r = result?.result as Json | undefined;
  check("audit completes", r?.status === "complete", events.filter((e) => e.type !== "heartbeat").map((e) => e.type));
  if (!result || r?.status !== "complete") return;
  check("audit time", true, `${((Date.now() - t0) / 1000).toFixed(0)} s, model attempts ${(result.model as Json)?.attempts}`);
  check("brief keeps the rule's priority", result.priorityKept === true, { rule: (r.priority as Json).name, brief: (result.brief as Json).priority });
  const table = r.table as Json[];
  const backup = table[table.length - 1];
  const afterAudit = await usage();
  check("audit counted once", afterAudit.usedToday === before.usedToday + 1, afterAudit);

  const vb = await readJob(await post("api/veto", { state: result.state, veto: { id: backup.id, reason: "dates" } }));
  const vbr = vb.find((e) => e.type === "result") as Json | undefined;
  const sameP = ((vbr?.result as Json)?.priority as Json)?.id === (r.priority as Json).id;
  check("veto backup: priority unchanged, explanation not re-queried", sameP && ((vbr?.context as Json)?.explanation as Json)?.refetched === false, vbr?.context);
  check("veto backup not counted", (await usage()).usedToday === afterAudit.usedToday, await usage());

  const vp = await readJob(await post("api/veto", { state: vbr!.state, veto: { id: (r.priority as Json).id, reason: "fee" } }));
  const vpr = vp.find((e) => e.type === "result") as Json | undefined;
  const newP = (vpr?.result as Json)?.priority as Json | undefined;
  check("veto priority: new priority, explanation re-queried", !!newP && newP.id !== (r.priority as Json).id && ((vpr?.context as Json)?.explanation as Json)?.refetched === true, newP?.name);
  check("veto priority counted", (await usage()).usedToday === afterAudit.usedToday + 1, await usage());
  check("only one candidate left", ((vpr?.result as Json)?.table as Json[])?.length === 1, ((vpr?.result as Json)?.table as Json[])?.length);

  const share = (await (await post("api/share", { payload: { version: 1, savedAt: new Date().toISOString(), input: CASE, result: vpr!.result, brief: vpr!.brief, context: vpr!.context } })).json()) as Json;
  const page = await (await fetch(`${BASE}/b?t=${share.token}`)).text();
  check("share page renders the saved priority", page.includes(String(newP?.name)) && page.includes("Latest change"), String(share.token).length + " chars");
  const tampered = String(share.token).slice(0, -3) + (String(share.token).endsWith("AAA") ? "BBB" : "AAA");
  const bad = await (await fetch(`${BASE}/b?t=${tampered}`)).text();
  check("tampered share link rejected", bad.includes("invalid or was modified"), "");
}

async function main(): Promise<void> {
  console.log(`E2E against ${BASE}`);
  await staticAndValidation();
  await fullFlow(); // first, so a run right after a restart measures the cold path
  await busyAndCancel();
  console.log(failures ? `${failures} step(s) failed` : "all steps passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
