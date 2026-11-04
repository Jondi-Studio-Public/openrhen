import { describe, expect, it } from "vitest";
import {
  CLOSED_BADGE_WINDOW_HOURS,
  CLOSED_TABS,
  canRestoreWithBatch,
  classifyClosedBy,
  closedPageSchema,
  closedRowSchema,
  closedSummarySchema,
  isAgentCloseForBadge,
  isHiddenFromClosedList,
  restoreVerbFor
} from "./closed-list.js";

/** Every literal below is typed by hand from the design (section 5 stamps, section 4 badge); nothing is read back from the module. */
describe("classifyClosedBy", () => {
  const table: [string | null, string, string?][] = [
    [null, "unknown"],
    ["", "unknown"],
    ["person", "person"],
    ["system", "system"],
    ["agent:claude", "agent", "claude"],
    ["agent:my-bot_2", "agent", "my-bot_2"],
    ["agent:claude:confirmed", "confirmed", "claude"],
    ["person:undo", "undo"],
    ["agent:claude:undo", "undo"],
    ["agent:Claude", "unknown"],
    ["agent:", "unknown"],
    ["agent:a:b:c", "unknown"],
    ["agent:claude:confirmed:undo", "undo"],
    ["somebody", "unknown"]
  ];
  it.each(table)("%s is %s", (closedBy, kind, agent) => {
    const got = classifyClosedBy(closedBy);
    expect(got.kind).toBe(kind);
    expect(got.agent).toBe(agent);
  });

  it("an agent name is at most 32 characters and has no colon, so the suffix cannot be forged", () => {
    expect(classifyClosedBy(`agent:${"a".repeat(32)}`).kind).toBe("agent");
    expect(classifyClosedBy(`agent:${"a".repeat(33)}`).kind).toBe("unknown");
  });
});

describe("hidden and badge rules", () => {
  it("hides only the closes that took back a create", () => {
    expect(isHiddenFromClosedList("person:undo")).toBe(true);
    expect(isHiddenFromClosedList("agent:claude:undo")).toBe(true);
    for (const shown of [null, "person", "system", "agent:claude", "agent:claude:confirmed"])
      expect(isHiddenFromClosedList(shown)).toBe(false);
  });

  it("counts for the badge only a plain agent close", () => {
    expect(isAgentCloseForBadge("agent:claude")).toBe(true);
    for (const other of [null, "person", "system", "agent:claude:confirmed", "agent:claude:undo", "person:undo"])
      expect(isAgentCloseForBadge(other)).toBe(false);
  });

  it("the badge window is 24 hours", () => expect(CLOSED_BADGE_WINDOW_HOURS).toBe(24));
});

describe("restoreVerbFor", () => {
  it("follows the row's closed status, so a legacy cancelled area uses cancel", () => {
    expect(restoreVerbFor("cancelled")).toBe("cancel");
    expect(restoreVerbFor("archived")).toBe("archive");
  });
  it("has two tabs, archived then cancelled", () => expect([...CLOSED_TABS]).toEqual(["archived", "cancelled"]));
});

const row = {
  type: "project",
  id: "p1",
  title: "Quarterly report",
  parent: "Finance",
  status: "cancelled",
  version: 4,
  closedAt: "2026-11-04T10:00:00.000Z",
  closedBy: "agent:claude",
  reason: "Not needed",
  fromStatus: "active",
  batchSize: 3,
  blockedBy: null,
  restoreVerb: "cancel"
};

describe("closed wire schemas", () => {
  it("accepts a row, a page and a summary", () => {
    expect(closedRowSchema.parse(row).title).toBe("Quarterly report");
    expect(
      closedPageSchema.parse({ rows: [row], nextCursor: null, counts: { archived: 0, cancelled: 1 } }).rows
    ).toHaveLength(1);
    expect(closedSummarySchema.parse({ agentLast24h: 2, latestAt: "2026-11-04T10:00:00.000Z" }).agentLast24h).toBe(2);
  });
  it("accepts the nulls a legacy row has", () => {
    const legacy = { ...row, closedAt: null, closedBy: null, reason: null, fromStatus: null, batchSize: 0 };
    expect(closedRowSchema.parse(legacy).closedBy).toBeNull();
  });
  it("refuses an unknown type, status or verb", () => {
    expect(closedRowSchema.safeParse({ ...row, type: "capture" }).success).toBe(false);
    expect(closedRowSchema.safeParse({ ...row, status: "active" }).success).toBe(false);
    expect(closedRowSchema.safeParse({ ...row, restoreVerb: "delete" }).success).toBe(false);
  });
});

describe("canRestoreWithBatch", () => {
  const base = { type: "outcome", batchSize: 3 } as const;
  it("offers the batch for an area, outcome or project closed with others", () => {
    for (const type of ["area", "outcome", "project"] as const)
      expect(canRestoreWithBatch({ type, batchSize: 2 })).toBe(true);
  });
  it("does not for a lone row, or for types whose restore needs no choice", () => {
    expect(canRestoreWithBatch({ ...base, batchSize: 1 })).toBe(false);
    expect(canRestoreWithBatch({ ...base, batchSize: 0 })).toBe(false);
    // a commitment always restores its own batch; the rest have no children
    for (const type of ["commitment", "action", "deliverable", "routine_preset", "condition_definition"] as const)
      expect(canRestoreWithBatch({ type, batchSize: 5 })).toBe(false);
  });
});
