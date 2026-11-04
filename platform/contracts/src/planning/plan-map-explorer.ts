import { z } from "zod";
import {
  canPropose,
  planLinkKindSchema,
  planItemTypeSchema,
  validateLink,
  type PlanItemType,
  type PlanLinkKind
} from "./plan-map.js";
import type { ExistingLink } from "./plan-map-proposers.js";

/**
 * Plan map explorer and executor. The explorer walks the plan through
 * the navigator and returns an answer and what it would change; the executor turns the changes into
 * suggested links or findings. Both are advisory: an explorer result is a proposal, never a write. The pure
 * parts live here: the result shape, the caps, how an answer is scored against a task, the comparison
 * between backends, and how proposed changes become link candidates. The model loop is the reasoner service's.
 */

/** A walk stops, marked incomplete, at either cap rather than failing. */
export const EXPLORER_MAX_CALLS = 8;
export const EXPLORER_MAX_TOKENS = 20_000;
/** A cached answer is dropped after this long even if nothing it rests on changed. */
export const EXPLORER_CACHE_TTL_HOURS = 24;
/** Proposals one walk may record; a model that returns more in a turn has the rest refused. */
export const EXPLORER_MAX_PROPOSALS = 20;

/** Who ran a walk: the hosted cheap model or the local one. Only these two are compared. */
export const EXPLORER_BACKENDS = ["haiku", "local"] as const;
export const explorerBackendSchema = z.enum(EXPLORER_BACKENDS);
export type ExplorerBackend = z.infer<typeof explorerBackendSchema>;

/** `<type>:<id>`, as the navigator names an item. */
const handleSchema = z.string().regex(/^[a-z_]+:.+$/, "Expected a handle like project:abc");

export const explorerLinkChangeSchema = z.object({
  type: z.literal("link"),
  kind: planLinkKindSchema,
  from: handleSchema,
  to: handleSchema,
  evidence: z.string().min(1).max(400)
});
export const explorerFindingChangeSchema = z.object({
  type: z.literal("finding"),
  text: z.string().min(1).max(500),
  itemIds: z.array(handleSchema).max(10),
  evidence: z.string().min(1).max(400)
});
export const explorerChangeSchema = z.discriminatedUnion("type", [
  explorerLinkChangeSchema,
  explorerFindingChangeSchema
]);
export type ExplorerChange = z.infer<typeof explorerChangeSchema>;

export const explorerResultSchema = z.object({
  answer: z.string(),
  /** Handles the answer names. */
  itemIds: z.array(handleSchema),
  evidence: z.array(z.string()),
  proposedChanges: z.array(explorerChangeSchema),
  tokens: z.object({ input: z.number().int().min(0), output: z.number().int().min(0) }),
  calls: z.number().int().min(0),
  ms: z.number().int().min(0),
  /** Hit the call or token cap, or the model never finished: the answer is what it had. */
  incomplete: z.boolean(),
  error: z.string().nullable()
});
export type ExplorerResult = z.infer<typeof explorerResultSchema>;

/** One entry of the fixed task set. `expected` is the handles a correct answer names. */
export const explorerTaskSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  expected: z.array(handleSchema)
});
export type ExplorerTask = z.infer<typeof explorerTaskSchema>;

export interface TaskScore {
  /** Share of the expected handles the answer named; 1 when none were expected and none were named. */
  recall: number;
  /** Share of the named handles that were expected; 1 when none were named and none were expected. */
  precision: number;
  /** Harmonic mean of the two, the single number the comparison shows. */
  f1: number;
}

function ratio(hit: number, total: number): number {
  return total === 0 ? 1 : hit / total;
}

/** Scores an answer's handles against a task's expected handles. Order and duplicates do not matter. */
export function scoreAnswer(expected: readonly string[], named: readonly string[]): TaskScore {
  const want = new Set(expected);
  const got = new Set(named);
  let hit = 0;
  for (const handle of got) if (want.has(handle)) hit += 1;
  const recall = ratio(hit, want.size);
  const precision = ratio(hit, got.size);
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return { recall, precision, f1 };
}

/** One walk as the shadow log keeps it, scored when the task had an expected answer. */
export interface ExplorerRunRecord {
  backend: ExplorerBackend;
  model: string;
  taskId: string;
  result: ExplorerResult;
  /** Null for a live lookup, which has no expected answer. */
  score: TaskScore | null;
  cached: boolean;
  /** A fixed task, or a live lookup beside `planSearch`; reports keep them apart. */
  kind?: "task" | "live";
}

export interface BackendSummary {
  backend: ExplorerBackend;
  runs: number;
  scored: number;
  /** Mean F1 over scored runs, or null before the first. */
  meanF1: number | null;
  meanTokens: number;
  meanCalls: number;
  meanMs: number;
  incomplete: number;
  failed: number;
}

/** Aggregates records per backend, for the side-by-side the owner picks from. Cached runs cost nothing and are left out. */
export function summariseBackends(records: readonly ExplorerRunRecord[]): BackendSummary[] {
  const summaries: BackendSummary[] = [];
  for (const backend of EXPLORER_BACKENDS) {
    const own = records.filter((record) => record.backend === backend && !record.cached);
    if (own.length === 0) continue;
    const scored = own.filter((record) => record.score !== null);
    const mean = (values: number[]): number =>
      values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
    summaries.push({
      backend,
      runs: own.length,
      scored: scored.length,
      meanF1: scored.length === 0 ? null : mean(scored.map((record) => record.score!.f1)),
      meanTokens: mean(own.map((record) => record.result.tokens.input + record.result.tokens.output)),
      meanCalls: mean(own.map((record) => record.result.calls)),
      meanMs: mean(own.map((record) => record.result.ms)),
      incomplete: own.filter((record) => record.result.incomplete).length,
      failed: own.filter((record) => record.result.error !== null).length
    });
  }
  return summaries;
}

export interface ExplorerLinkCandidate {
  kind: PlanLinkKind;
  fromType: PlanItemType;
  fromId: string;
  toType: PlanItemType;
  toId: string;
  evidence: string[];
}

export interface ExecutorPlan {
  links: ExplorerLinkCandidate[];
  findings: { text: string; itemIds: string[]; evidence: string[] }[];
  /** Changes that could not become a suggestion, each with why. */
  rejected: { change: ExplorerChange; reason: string }[];
}

/** Splits a handle into its type and id; null when the type is not a plan item type. */
export function parseHandle(handle: string): { type: PlanItemType; id: string } | null {
  const at = handle.indexOf(":");
  if (at < 1) return null;
  const type = planItemTypeSchema.safeParse(handle.slice(0, at));
  const id = handle.slice(at + 1);
  return type.success && id ? { type: type.data, id } : null;
}

/** The most suggestions one explorer result may become, so a rambling model cannot flood the review window. */
export const EXECUTOR_MAX_LINKS_PER_RESULT = 5;
export const EXECUTOR_MAX_FINDINGS_PER_RESULT = 3;

/**
 * The executor's pure half: validates each proposed change against the link rules and the store, and
 * returns what would be written. A pair already suggested, confirmed or rejected is skipped like any
 * proposer's. Deletes are not representable, so none can come out.
 */
export function planExecution(changes: readonly ExplorerChange[], existing: readonly ExistingLink[]): ExecutorPlan {
  const plan: ExecutorPlan = { links: [], findings: [], rejected: [] };
  const seen = new Set<string>();
  for (const change of changes) {
    if (change.type === "finding") {
      if (plan.findings.length >= EXECUTOR_MAX_FINDINGS_PER_RESULT) {
        plan.rejected.push({ change, reason: `At most ${EXECUTOR_MAX_FINDINGS_PER_RESULT} findings per result.` });
        continue;
      }
      plan.findings.push({ text: change.text, itemIds: change.itemIds, evidence: [change.evidence] });
      continue;
    }
    const from = parseHandle(change.from);
    const to = parseHandle(change.to);
    if (!from || !to) {
      plan.rejected.push({ change, reason: "A handle does not name a plan item type." });
      continue;
    }
    const candidate: ExplorerLinkCandidate = {
      kind: change.kind,
      fromType: from.type,
      fromId: from.id,
      toType: to.type,
      toId: to.id,
      evidence: [change.evidence]
    };
    const valid = validateLink(candidate);
    if (!valid.ok) {
      plan.rejected.push({ change, reason: valid.reason });
      continue;
    }
    const key = [candidate.kind, candidate.fromType, candidate.fromId, candidate.toType, candidate.toId].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    if (!canPropose(existing, candidate, false)) {
      plan.rejected.push({ change, reason: "Already suggested, confirmed or rejected." });
      continue;
    }
    if (plan.links.length >= EXECUTOR_MAX_LINKS_PER_RESULT) {
      plan.rejected.push({ change, reason: `At most ${EXECUTOR_MAX_LINKS_PER_RESULT} links per result.` });
      continue;
    }
    plan.links.push(candidate);
  }
  return plan;
}
