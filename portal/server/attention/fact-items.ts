import {
  ATTENTION_FOLD_AFTER,
  factOpenItem,
  sortAttentionItems,
  type AttentionFactInput,
  type AttentionItem
} from "@openrhen/contracts";
import type { FactFold } from "@openrhen/communication-readers";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readFactEvidence, readOpenFacts, type FactEvidence } from "@/server/persistence/postgres/open-facts-store";
import { readPlanFactHolds } from "@/server/persistence/postgres/plan-fact-notes-store";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";

/**
 * The open mail facts as attention items (`fact_open`). Derived facts are not plan data: this reads the folded open
 * facts (`readOpenFacts`: reply closure, age-out, links, statuses), takes out the ones an open plan action's note
 * carries (`fact_id:<id>`; see `readPlanFactHolds`), and builds one item each. The quoted mail text is read only for the items the feed will
 * list (the first five in order, the contract's `ATTENTION_FOLD_AFTER`), so the read of message text is bounded; the
 * counts pass `quotes: false` and get the same items without it. At most `FACT_ITEMS_MAX` facts are listed, so a
 * count above that is capped (stated limit).
 *
 * Whether a person's status beats Mark's whatever the time is an open design question; it lives in `resolveFactStatus`
 * and the fold, not here, so this read does not change when it is decided.
 */
export const FACT_ITEMS_MAX = 200;

interface FactItemsOptions {
  now: Date;
  held: readonly string[] | undefined;
  quotes: boolean;
}

const inputOf = (fold: FactFold, generatedAt: string, held: readonly string[] | undefined): AttentionFactInput => ({
  factId: fold.factId,
  factType: fold.factType,
  direction: fold.direction,
  at: fold.recentAt,
  dueAt: fold.dueAt,
  reopened: fold.reopened,
  updateSeen: fold.updateSeen,
  held,
  generatedAt
});

export async function readFactItems(sql: PoolSql, options: FactItemsOptions): Promise<AttentionItem[]> {
  const { now, held } = options;
  const generatedAt = now.toISOString();
  const open = await readOpenFacts(sql, { now, limit: FACT_ITEMS_MAX });
  if (open.facts.length === 0) return [];
  const userId = await ensureUser(sql);
  const holds = await readPlanFactHolds(sql, userId);
  // Hidden only while an open action holds the id, and only if no mail came after that action was last touched.
  const folds = open.facts.filter((fold) => {
    const hold = holds.get(fold.factId);
    if (hold === undefined || !hold.open || hold.openUpdatedAt === null) return true;
    return Date.parse(fold.recentAt) > hold.openUpdatedAt.getTime();
  });

  const details = new Map<string, FactEvidence>();
  const quotable = new Set<string>();
  if (options.quotes) {
    const ranked = sortAttentionItems(
      folds.flatMap((fold) => factOpenItem(inputOf(fold, generatedAt, held)) ?? [])
    ).slice(0, ATTENTION_FOLD_AFTER);
    const keys = ranked.flatMap((item) =>
      folds.filter((f) => `fact_open:${f.factId}` === item.id).map((f) => f.rowKey)
    );
    for (const item of await readFactEvidence(sql, userId, { keys })) details.set(item.key, item);
    for (const key of keys) quotable.add(key);
  }

  const items: AttentionItem[] = [];
  for (const fold of folds) {
    const input = inputOf(fold, generatedAt, held);
    const evidence = details.get(fold.rowKey);
    const item = factOpenItem(
      evidence
        ? {
            ...input,
            tier: evidence.tier,
            needsReview: evidence.reviewReason,
            who: evidence.who,
            quoteState: evidence.state === null ? "no_quote" : evidence.state,
            quote: evidence.text
          }
        : {
            ...input,
            ...(options.quotes
              ? { quoteState: quotable.has(fold.rowKey) ? ("missing" as const) : ("not_read" as const) }
              : {})
          }
    );
    if (item) items.push(item);
  }
  return items;
}
