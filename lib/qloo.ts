// Minimal Qloo client for the hackathon environment.
// Only the parameters listed in Task/technical-design.md are supported. Response
// parsing is deliberately left to callers until T04 confirms real field paths.

export const HACKATHON_BASE_URL = "https://hackathon.api.qloo.com";

export type DomainType = "urn:entity:artist" | "urn:entity:movie";

export interface QlooConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

export interface InsightsRequest {
  type: DomainType;
  seeds: string[];
  exclude?: string[];
  take?: number;
  explainability?: boolean;
  // Movies only; sent only after staff confirm a decade window.
  releaseYear?: { min: number; max: number };
}

export interface QlooCall {
  endpoint: string;
  params: Record<string, string>;
  status: number;
  ms: number;
  body: unknown;
}

export class QlooError extends Error {
  constructor(
    message: string,
    readonly kind: "config" | "input" | "http" | "timeout" | "network" | "parse",
    readonly status?: number,
  ) {
    super(message);
    this.name = "QlooError";
  }
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): QlooConfig {
  const apiKey = env.QLOO_API_KEY?.trim();
  const baseUrl = env.QLOO_BASE_URL?.trim();
  if (!apiKey) throw new QlooError("QLOO_API_KEY is not set", "config");
  if (baseUrl !== HACKATHON_BASE_URL) {
    throw new QlooError(`QLOO_BASE_URL must be ${HACKATHON_BASE_URL}, got ${baseUrl ?? "(unset)"}`, "config");
  }
  return { apiKey, baseUrl };
}

const dedupe = (ids: string[]) => [...new Set(ids.map((id) => id.trim()).filter(Boolean))];

export function buildSearchParams(query: string, types: DomainType[], take = 5): Record<string, string> {
  const q = query.trim();
  if (!q) throw new QlooError("search query is empty", "input");
  if (types.length === 0) throw new QlooError("search needs at least one type", "input");
  return { query: q, types: types.join(","), take: String(take) };
}

export function buildInsightsParams(req: InsightsRequest): Record<string, string> {
  const seeds = dedupe(req.seeds);
  const exclude = dedupe(req.exclude ?? []);
  if (seeds.length === 0) throw new QlooError("insights needs at least one seed entity", "input");
  const overlap = seeds.filter((id) => exclude.includes(id));
  if (overlap.length > 0) throw new QlooError(`entities are both seed and excluded: ${overlap.join(",")}`, "input");
  const take = req.take ?? 10;
  if (!Number.isInteger(take) || take < 1 || take > 50) throw new QlooError(`take out of range: ${take}`, "input");

  const params: Record<string, string> = {
    "filter.type": req.type,
    "signal.interests.entities": seeds.join(","),
    take: String(take),
  };
  if (exclude.length > 0) params["filter.exclude.entities"] = exclude.join(",");
  if (req.explainability) params["feature.explainability"] = "true";
  if (req.releaseYear) {
    if (req.type !== "urn:entity:movie") {
      throw new QlooError("release year filtering is only supported for movies", "input");
    }
    const { min, max } = req.releaseYear;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new QlooError(`invalid release year window: ${min}-${max}`, "input");
    }
    params["filter.release_year.min"] = String(min);
    params["filter.release_year.max"] = String(max);
  }
  return params;
}

export async function qlooGet(
  config: QlooConfig,
  endpoint: "/search" | "/v2/insights",
  params: Record<string, string>,
): Promise<QlooCall> {
  const url = new URL(endpoint, config.baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-Api-Key": config.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new QlooError(`${endpoint}: ${String(err)}`, timedOut ? "timeout" : "network");
  }
  const ms = Math.round(performance.now() - started);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new QlooError(`${endpoint}: non-JSON response (HTTP ${res.status})`, "parse", res.status);
  }
  if (!res.ok) {
    const reason = typeof body === "object" && body !== null ? JSON.stringify(body).slice(0, 300) : text.slice(0, 300);
    throw new QlooError(`${endpoint}: HTTP ${res.status} ${reason}`, "http", res.status);
  }
  return { endpoint, params, status: res.status, ms, body };
}
