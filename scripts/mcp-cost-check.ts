// T04: measure real HTTP cost of describe -> rank inside one long-lived `qloo mcp` process (D2, side A).
// The month counter comes from Qloo's x-month-ratelimit-remaining header via one cheap /search request.
import { QlooMcp } from "../lib/qloo-mcp";

const D2 = {
  headliner: "Khruangbin",
  shortlist: ["Men I Trust", "Bahamas", "Hermanos Gutiérrez", "Parcels", "Thee Sacred Souls", "Glass Beams", "31DA05F2-0096-4209-94FA-3AE331190494", "L'Impératrice", "Crumb", "Babe Rainbow"],
};

async function monthRemaining(): Promise<number> {
  const res = await fetch("https://hackathon.api.qloo.com/search?query=Khruangbin&types=urn:entity:artist&take=1", {
    headers: { "X-Api-Key": process.env.QLOO_API_KEY! },
  });
  await new Promise((r) => setTimeout(r, 1500));
  return Number(res.headers.get("x-month-ratelimit-remaining"));
}

async function main(): Promise<void> {
  const mcp = new QlooMcp();
  const tools = await mcp.listTools();
  console.log("tools:", tools.join(", "));

  const r0 = await monthRemaining();
  const ids: string[] = [];
  for (const name of [D2.headliner, ...D2.shortlist]) {
    const out = await mcp.call("qloo_describe", { entity: name, type: "artist" });
    ids.push(((out.interpretation as { entity?: { entityId?: string } })?.entity?.entityId) ?? `UNRESOLVED:${name}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const r1 = await monthRemaining();
  const [head, ...pool] = ids;
  const rankById = await mcp.call("qloo_rank", { options: pool, option_type: "artist", signals: [head] });
  const r2 = await monthRemaining();
  const rankAgain = await mcp.call("qloo_rank", { options: pool, option_type: "artist", signals: [head] });
  const r3 = await monthRemaining();
  mcp.close();

  const status = (o: Record<string, unknown>) => (o.status as string) ?? JSON.stringify(o.error ?? o).slice(0, 200);
  console.log(JSON.stringify({
    unresolved: ids.filter((i) => i.startsWith("UNRESOLVED")),
    describeHttp: r0 - r1 - 1,
    rankFirst: { status: status(rankById), http: r1 - r2 - 1, results: (rankById.results as unknown[] | undefined)?.length },
    rankRepeat: { status: status(rankAgain), http: r2 - r3 - 1, results: (rankAgain.results as unknown[] | undefined)?.length },
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
