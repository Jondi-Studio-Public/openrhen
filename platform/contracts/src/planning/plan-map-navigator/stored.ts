import type { PlanIndex } from "./derive.js";
import { STORED_KINDS, type StoredLink } from "./model.js";

/** A stored link as the link store holds it: typed ends, a kind, a status, and the evidence behind it. */
export interface StoredLinkRow {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  kind: string;
  status: string;
  evidence?: readonly string[];
}

/**
 * Turns link-store rows into the navigator's `<type>:<id>` form. Only confirmed and suggested links of a
 * kind the design defines get through, so a rejected or expired row, or a kind from a newer portal, never
 * reaches a map.
 */
export function toStoredLinks(rows: readonly StoredLinkRow[]): StoredLink[] {
  const kinds: readonly string[] = STORED_KINDS;
  const links: StoredLink[] = [];
  for (const row of rows) {
    if (row.status !== "confirmed" && row.status !== "suggested") continue;
    if (!kinds.includes(row.kind)) continue;
    links.push({
      from: `${row.fromType}:${row.fromId}`,
      to: `${row.toType}:${row.toId}`,
      kind: row.kind,
      status: row.status,
      ...(row.evidence && row.evidence.length > 0 ? { evidence: [...row.evidence] } : {})
    });
  }
  return links;
}

/**
 * The handle a stored link end names in this plan. A recurring commitment is linked through its rule, and
 * the store files that as `commitment:<ruleId>`; the plan holds the rule as its own item, so that end
 * resolves to `rule:<ruleId>` when no commitment has the id.
 */
export function resolveStoredEnd(index: PlanIndex, handle: string): string {
  if (index.items.has(handle) || !handle.startsWith("commitment:")) return handle;
  const asRule = `rule:${handle.slice("commitment:".length)}`;
  return index.items.has(asRule) ? asRule : handle;
}
