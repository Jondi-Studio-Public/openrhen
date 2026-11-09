import { sanitiseQuoted } from "@openrhen/contracts";
import { agentMarks, foldFactStates, openFacts, type AgentMark } from "@openrhen/communication-readers";
import { ensureUser } from "./ensure-user";
import {
  OPEN_FACTS_STATEMENT_TIMEOUT,
  OpenFactsTimeoutError,
  readFactEvidence,
  readFactFoldInput
} from "./open-facts-store";
import { readPlanFactHolds } from "./plan-fact-notes-store";
import type { PoolSql } from "./sql-pool";

/**
 * The listing behind `rhen_inbox` room `facts` (communication understanding, slice 2b-9): the open mail facts with their
 * ids, and the marks the asking agent made that it can still take back. Read only, one REPEATABLE READ transaction.
 *
 * What it returns is data, not text for an agent to obey: a fact is its type, its due time and its id; only the first
 * `FACT_QUOTES` items carry a quote of the mail (the grounded span, run through the feed's sanitiser, never more than
 * 200 characters), which the caller must show fenced as untrusted. Every other string is a closed value of this server.
 */

export const FACT_LISTING_LIMIT_DEFAULT = 20;
export const FACT_LISTING_LIMIT_MAX = 200;
/** How many items carry a quote: the same five the attention feed quotes (`readFactEvidence` reads message text). */
export const FACT_QUOTES = 5;
/** How many standing marks are listed (the rest are counted). */
export const FACT_MARKS_LISTED = 20;

export interface FactListItem {
  id: string;
  type: string;
  direction: "in" | "out" | null;
  dueAt: string | null;
  at: string;
  reopened: boolean;
  /** A cancel or a new time arrived that a recorded status overrode. */
  updateSeen: boolean;
  /** An open plan action holds this fact (its note carries `fact_id:`) and no later mail came after it. */
  onPlan: boolean;
  tier: string | null;
  needsReview: string | null;
  /** Untrusted mail text: the sanitised sender and quote, for the first items only. */
  who?: string;
  quote?: string;
  quoteState: "ok" | "source_removed" | "source_changed" | "no_quote" | "missing" | "not_read";
}

export interface FactMark extends AgentMark {
  id: string;
}

export interface FactListing {
  generatedAt: string;
  total: number;
  facts: FactListItem[];
  marks: FactMark[];
  marksTotal: number;
  truncated: boolean;
  problems: string[];
}

/**
 * The routes' reads share one fold per person, agent and limit: a read already in flight is joined, and an answer is
 * reused for `FACT_LISTING_TTL_MS`. A mark clears it (`clearFactListingCache`), so the agent never reads its own write
 * back stale. Only a caller that asks (`shared: true`) takes part; the default is a fresh read.
 */
export const FACT_LISTING_TTL_MS = 5000;
const shared = new Map<string, { at: number; read: Promise<FactListing> }>();
export function clearFactListingCache(): void {
  shared.clear();
}

export async function readFactListing(
  sql: PoolSql,
  options: { now: Date; limit?: number; agent: string | null; shared?: boolean }
): Promise<FactListing> {
  if (options.shared !== true) return readFresh(sql, options);
  const userId = await ensureUser(sql);
  const key = `${userId}|${options.agent ?? ""}|${options.limit ?? ""}`;
  const held = shared.get(key);
  if (held !== undefined && Date.now() - held.at < FACT_LISTING_TTL_MS) return held.read;
  const read = readFresh(sql, options);
  const entry = { at: Date.now(), read };
  shared.set(key, entry);
  read.catch(() => {
    if (shared.get(key) === entry) shared.delete(key);
  });
  return read;
}

async function readFresh(
  sql: PoolSql,
  options: { now: Date; limit?: number; agent: string | null }
): Promise<FactListing> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? FACT_LISTING_LIMIT_DEFAULT), 1), FACT_LISTING_LIMIT_MAX);
  const userId = await ensureUser(sql);
  try {
    return await sql.begin("isolation level repeatable read read only", async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${OPEN_FACTS_STATEMENT_TIMEOUT}'`);
      const read = await readFactFoldInput(tx, userId, { now: options.now });
      const folds = foldFactStates(read.input);
      const open = openFacts(folds);
      const shown = open.slice(0, limit);
      const holds = await readPlanFactHolds(tx, userId);
      const evidence = new Map(
        (await readFactEvidence(tx, userId, { keys: shown.slice(0, FACT_QUOTES).map((fold) => fold.rowKey) })).map(
          (item) => [item.key, item]
        )
      );
      const facts = shown.map((fold, index): FactListItem => {
        const hold = holds.get(fold.factId);
        const detail = evidence.get(fold.rowKey);
        const who = detail ? sanitiseQuoted(detail.who.join(", ")) : undefined;
        const quote = detail?.state === "ok" ? sanitiseQuoted(detail.text) : undefined;
        return {
          id: fold.factId,
          type: fold.factType,
          direction: fold.direction,
          dueAt: fold.dueAt,
          at: fold.recentAt,
          reopened: fold.reopened,
          updateSeen: fold.updateSeen,
          onPlan:
            hold !== undefined &&
            hold.open &&
            hold.openUpdatedAt !== null &&
            Date.parse(fold.recentAt) <= hold.openUpdatedAt.getTime(),
          tier: detail?.tier ?? null,
          needsReview: detail?.reviewReason ?? null,
          ...(who ? { who } : {}),
          ...(quote ? { quote } : {}),
          quoteState:
            index >= FACT_QUOTES ? "not_read" : detail === undefined ? "missing" : (detail.state ?? "no_quote")
        };
      });
      const marks = options.agent === null ? [] : agentMarks(read.input, options.agent);
      return {
        generatedAt: options.now.toISOString(),
        total: open.length,
        facts,
        marks: marks.slice(0, FACT_MARKS_LISTED).map((mark) => ({ ...mark, id: mark.factId })),
        marksTotal: marks.length,
        truncated: read.truncated,
        problems: read.problems
      };
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "57014") throw new OpenFactsTimeoutError();
    throw error;
  }
}
