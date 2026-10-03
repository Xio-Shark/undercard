// Machine-checkable constraints for one brief (T10). These are rule and source checks only; whether the
// information helped is the author's self-assessment and is recorded separately.
import type { Brief } from "../lib/llm";

export interface CheckInput {
  version: "qloo" | "llm_only";
  brief: Brief;
  inPlay: string[];
  vetoed: string[];
  /** The server rule's priority (Qloo version only). */
  rulePriority?: string;
}

export interface Checks {
  /** Priority is null or one of the acts still in play. */
  priorityInPlay: boolean;
  /** Neither the priority nor a backup is a vetoed act. */
  respectsVetoes: boolean;
  /** Backups are in play and differ from the priority. */
  backupsInPlay: boolean;
  /** Qloo version: the brief kept the server rule's choice. null for LLM-only. */
  keptRule: boolean | null;
  /** LLM-only must not cite Qloo as a source: it had no Qloo data. */
  qlooCitationsWithoutData: number;
  /** "No percentages or invented numbers" (shared instructions); counts "%" figures in all text. */
  percentFigures: number;
  /** LLM-only: rank-like numbers without any rank data ("rank 2", "#3", "ranks ... 1 Lucy Dacus"). */
  numericRanksWithoutData: number;
  /** Instructions ask for at most 8; reported, not failed (a soft target). */
  evidenceCount: number;
  /** T19: internal source labels or field names leaking into the text, e.g. "(product_rule)", "headlinerRank", "qlooNotes". */
  jargonLeaks: number;
}

// "rank 2", "ranked 3rd", "#1", "rank ... : 1 Lucy Dacus, 2 Julien Baker" (a number within a short span after "rank").
const RANK_LIKE = /#\d+|\brank(?:ed|s|ing)?\b[^.;\n]{0,40}?\b\d+(?:st|nd|rd|th)?\b/gi;

// Field names from the evidence JSON and parenthesised source labels; the page shows sources as chips instead.
const JARGON = /\((?:qloo|product_rule|general_knowledge)\)|\b(?:headlinerRank|targetRank|worstRank|qlooNotes|priorityTiedWithNext|audienceComparison|product_rule|general_knowledge)\b/g;

const texts = (b: Brief) => [b.answer, b.headlinerSide, b.targetSide, ...b.evidence.map((e) => e.claim), ...b.unknowns];

// Names are compared case-insensitively: "Beabadoobee" for Qloo's "beabadoobee" is the same act, not a new one.
const key = (n: string) => n.trim().toLowerCase();

export function checkBrief({ version, brief, inPlay, vetoed, rulePriority }: CheckInput): Checks {
  const inPlaySet = new Set(inPlay.map(key));
  const vetoSet = new Set(vetoed.map(key));
  const priority = brief.priority === null ? null : key(brief.priority);
  return {
    priorityInPlay: priority === null || inPlaySet.has(priority),
    respectsVetoes: ![priority, ...brief.backups.map(key)].some((n) => n !== null && vetoSet.has(n)),
    backupsInPlay: brief.backups.every((b) => inPlaySet.has(key(b)) && key(b) !== priority),
    keptRule: version === "qloo" ? priority === (rulePriority === undefined ? undefined : key(rulePriority)) : null,
    qlooCitationsWithoutData: version === "llm_only" ? brief.evidence.filter((e) => e.source === "qloo").length : 0,
    percentFigures: texts(brief).join("\n").match(/\d+(\.\d+)?\s*%/g)?.length ?? 0,
    numericRanksWithoutData: version === "llm_only" ? texts(brief).join("\n").match(RANK_LIKE)?.length ?? 0 : 0,
    evidenceCount: brief.evidence.length,
    jargonLeaks: texts(brief).join("\n").match(JARGON)?.length ?? 0,
  };
}

/** True when every check passes. */
export function allPass(c: Checks): boolean {
  return c.priorityInPlay && c.respectsVetoes && c.backupsInPlay && c.keptRule !== false && c.qlooCitationsWithoutData === 0 && c.percentFigures === 0 && c.numericRanksWithoutData === 0 && c.jargonLeaks === 0;
}
