/**
 * The wire shapes and pure rules of the Closed page and its 24 hour badge (archive-removals design sections 4 to 6).
 * `closed_by` is stamped by the database trigger (`person`, `agent:<name>`, `agent:<name>:confirmed`, `system`, or
 * either of the first and third with `:undo` for a close that took back a create); NULL is a row closed before the
 * stamps existed. The server read and the portal both classify through `classifyClosedBy`, so the SQL filters and the
 * words on the page cannot drift apart (the integration test runs the same strings through both).
 */
import { z } from "zod";
import { CLOSE_TYPES, UNDO_CLOSED_BY_SUFFIX, type CloseVerb } from "./closed-entity.js";

export const CLOSED_TABS = ["archived", "cancelled"] as const;
export type ClosedTab = (typeof CLOSED_TABS)[number];

/** How far back "closed by an agent" counts toward the badge. */
export const CLOSED_BADGE_WINDOW_HOURS = 24;

export type ClosedByKind = "person" | "agent" | "confirmed" | "undo" | "system" | "unknown";

export interface ClosedByClass {
  kind: ClosedByKind;
  /** The agent's name, for `agent` and `confirmed`. */
  agent?: string;
}

/** Agent names are `[a-z0-9_-]{1,32}` with no colon, so a `:confirmed` or `:undo` suffix cannot be forged inside one. */
const AGENT_NAME = /^[a-z0-9_-]{1,32}$/;

export function classifyClosedBy(closedBy: string | null | undefined): ClosedByClass {
  if (closedBy == null || closedBy === "") return { kind: "unknown" };
  if (closedBy.endsWith(UNDO_CLOSED_BY_SUFFIX)) return { kind: "undo" };
  if (closedBy === "person") return { kind: "person" };
  if (closedBy === "system") return { kind: "system" };
  if (closedBy.startsWith("agent:")) {
    const rest = closedBy.slice("agent:".length);
    if (AGENT_NAME.test(rest)) return { kind: "agent", agent: rest };
    if (rest.endsWith(":confirmed")) {
      const agent = rest.slice(0, -":confirmed".length);
      if (AGENT_NAME.test(agent)) return { kind: "confirmed", agent };
    }
  }
  return { kind: "unknown" };
}

/** A close that took back a create is not a decision to show the owner. */
export const isHiddenFromClosedList = (closedBy: string | null | undefined): boolean =>
  classifyClosedBy(closedBy).kind === "undo";

/** Only an agent's own close, not one the owner confirmed, counts toward the badge. */
export const isAgentCloseForBadge = (closedBy: string | null | undefined): boolean =>
  classifyClosedBy(closedBy).kind === "agent";

/** The verb that restores a row in this closed status (a legacy cancelled area is restored with cancel). */
export const restoreVerbFor = (status: ClosedTab): CloseVerb => (status === "archived" ? "archive" : "cancel");

/**
 * Whether a restore has a "with the rows closed with it" choice. An area, outcome or project restores its children
 * only when asked; a commitment always restores its own batch, and the other types have none.
 */
export const canRestoreWithBatch = (row: { type: string; batchSize: number }): boolean =>
  (row.type === "area" || row.type === "outcome" || row.type === "project") && row.batchSize > 1;

const closeTypeSchema = z.enum(CLOSE_TYPES);

export const closedRowSchema = z.object({
  type: closeTypeSchema,
  /** The id as the portal state shows it, which is what the close route takes. */
  id: z.string().min(1),
  title: z.string(),
  /** The area, outcome or project it sits under, for a line like "Action in Quarterly report". */
  parent: z.string().nullable(),
  status: z.enum(CLOSED_TABS),
  version: z.number().int().positive(),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  reason: z.string().nullable(),
  fromStatus: z.string().nullable(),
  /** Rows (this one included) closed in the same call and still closed; 0 when the row has no batch. */
  batchSize: z.number().int().nonnegative(),
  /** The closed row above it that has to be restored first (its status says which tab it is on). */
  blockedBy: z
    .object({ type: closeTypeSchema, id: z.string(), title: z.string(), status: z.enum(CLOSED_TABS) })
    .nullable(),
  restoreVerb: z.enum(["archive", "cancel"])
});
export type ClosedRow = z.infer<typeof closedRowSchema>;

export const closedPageSchema = z.object({
  rows: z.array(closedRowSchema),
  nextCursor: z.string().nullable(),
  /** Per tab, ignoring the type filter. */
  counts: z.object({ archived: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative() })
});
export type ClosedPage = z.infer<typeof closedPageSchema>;

export const closedSummarySchema = z.object({
  agentLast24h: z.number().int().nonnegative(),
  latestAt: z.string().nullable()
});
export type ClosedSummary = z.infer<typeof closedSummarySchema>;
