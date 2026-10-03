// T04 probe: real Search/Insights calls for the fictional dev profiles.
// Run: pnpm probe   (needs QLOO_API_KEY and QLOO_BASE_URL in .env.local)
// Raw responses go to .probe/<timestamp>/ (git-ignored). Review them by hand
// before copying any redacted conclusion into Task/evidence/T04-qloo-probe.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildInsightsParams,
  buildSearchParams,
  configFromEnv,
  qlooGet,
  QlooError,
  type DomainType,
  type InsightsRequest,
  type QlooConfig,
} from "../lib/qloo";

interface Seed { name: string; type: DomainType }
interface Profile { id: string; birthYear: number; seeds: Seed[] }
interface Entity { id: string; name: string; type?: string; year?: unknown; explain?: unknown }
interface Step {
  label: string;
  ok: boolean;
  ms?: number;
  params?: Record<string, string>;
  error?: string;
  entities?: Entity[];
  topLevelKeys?: string[];
  note?: string;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

// Documented paths only; anything else is reported as "not found", never guessed.
function entitiesOf(body: unknown, path: "results" | "results.entities"): Entity[] | undefined {
  const results = obj(body)?.results;
  const list = path === "results" ? results : obj(results)?.entities;
  if (!Array.isArray(list)) return undefined;
  return list.map((raw) => {
    const e = obj(raw) ?? {};
    const props = obj(e.properties);
    return {
      id: String(e.entity_id ?? ""),
      name: String(e.name ?? ""),
      type: e.type ? String(e.type) : undefined,
      year: props?.release_year,
      explain: obj(e.query)?.explainability,
    };
  });
}

const raw: unknown[] = [];

async function call(
  cfg: QlooConfig,
  label: string,
  endpoint: "/search" | "/v2/insights",
  build: () => Record<string, string>,
): Promise<Step> {
  let params: Record<string, string> | undefined;
  try {
    params = build();
    const res = await qlooGet(cfg, endpoint, params);
    raw.push({ label, ...res });
    const entities = entitiesOf(res.body, endpoint === "/search" ? "results" : "results.entities");
    return {
      label, ok: true, ms: res.ms, params, entities,
      topLevelKeys: Object.keys(obj(res.body) ?? {}),
      note: entities ? undefined : "entity list not found at documented path",
    };
  } catch (err) {
    const msg = err instanceof QlooError ? `${err.kind}: ${err.message}` : String(err);
    raw.push({ label, params, error: msg });
    return { label, ok: false, params, error: msg };
  }
}

const insights = (cfg: QlooConfig, label: string, req: InsightsRequest) =>
  call(cfg, label, "/v2/insights", () => buildInsightsParams(req));

const ids = (s: Step) => new Set((s.entities ?? []).map((e) => e.id));

async function probeProfile(cfg: QlooConfig, p: Profile): Promise<Step[]> {
  const steps: Step[] = [];
  const seedIds: string[] = [];
  for (const seed of p.seeds) {
    const s = await call(cfg, `${p.id} search "${seed.name}"`, "/search", () => buildSearchParams(seed.name, [seed.type]));
    const top = s.entities?.[0];
    if (top?.id) {
      seedIds.push(top.id);
      s.note = `probe took top-1 "${top.name}" for "${seed.name}"; needs human check`;
    }
    steps.push(s);
  }
  if (seedIds.length === 0) return [...steps, { label: `${p.id} insights`, ok: false, error: "no seed resolved" }];

  const base = { seeds: seedIds, take: 10, explainability: true };
  const artist = await insights(cfg, `${p.id} artist`, { ...base, type: "urn:entity:artist" });
  const movie = await insights(cfg, `${p.id} movie`, { ...base, type: "urn:entity:movie" });
  steps.push(artist, movie);

  const b = p.birthYear;
  steps.push(await insights(cfg, `${p.id} movie ${b + 10}-${b + 20}`, {
    ...base, type: "urn:entity:movie", releaseYear: { min: b + 10, max: b + 20 },
  }));
  steps.push(await insights(cfg, `${p.id} movie ${b + 21}-${b + 30}`, {
    ...base, type: "urn:entity:movie", releaseYear: { min: b + 21, max: b + 30 },
  }));

  const newArtist = artist.entities?.find((e) => e.id && !seedIds.includes(e.id));
  if (newArtist) {
    const after = await insights(cfg, `${p.id} movie +positive "${newArtist.name}"`, {
      ...base, type: "urn:entity:movie", seeds: [...seedIds, newArtist.id],
    });
    const before = ids(movie);
    after.note = `${[...ids(after)].filter((id) => !before.has(id)).length} movie ids not in pre-feedback run`;
    steps.push(after);
  }

  const toExclude = movie.entities?.find((e) => e.id && !seedIds.includes(e.id));
  if (toExclude) {
    const after = await insights(cfg, `${p.id} movie -exclude "${toExclude.name}"`, {
      ...base, type: "urn:entity:movie", exclude: [toExclude.id],
    });
    after.note = ids(after).has(toExclude.id) ? "EXCLUDED ID STILL PRESENT" : "excluded id absent";
    steps.push(after);
  }
  return steps;
}

function printStep(s: Step) {
  const head = s.ok ? `ok ${s.ms}ms` : "FAIL";
  console.log(`\n[${head}] ${s.label}${s.note ? `  (${s.note})` : ""}`);
  if (s.error) console.log(`  ${s.error}`);
  if (s.topLevelKeys) console.log(`  keys: ${s.topLevelKeys.join(", ")}`);
  for (const e of s.entities?.slice(0, 10) ?? []) {
    const year = e.year !== undefined ? ` ${String(e.year)}` : "";
    console.log(`  - ${e.name}${year} [${e.id}]${e.explain ? " +explain" : ""}`);
  }
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const cfg = configFromEnv();
  const { profiles } = JSON.parse(readFileSync("scripts/probe-profiles.json", "utf8")) as { profiles: Profile[] };
  const steps: Step[] = [];
  for (const p of profiles) steps.push(...(await probeProfile(cfg, p)));
  steps.forEach(printStep);

  const dir = join(".probe", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "calls.json"), JSON.stringify(raw, null, 2));
  writeFileSync(join(dir, "summary.json"), JSON.stringify(steps, null, 2));
  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length} steps, ${failed} failed. Raw output: ${dir}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof QlooError ? `${err.kind}: ${err.message}` : err);
  process.exit(1);
});
