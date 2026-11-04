import { describe, expect, it } from "vitest";
import { duplicateItems, type DoctorDuplicatesSlice } from "./doctor-duplicates.js";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

function slice(over: Partial<DoctorDuplicatesSlice> = {}): DoctorDuplicatesSlice {
  return { actions: [], proposals: [], openDuplicateFindingItemIds: [], deadLinkEnds: [], ...over };
}
const action = (id: string, title: string, projectId = "p1") => ({ id, title, projectId, createdAt: day(-3) });
const proposal = (id: string, title: string | null, sourceId = id, createdAt = day(-3)) => ({
  id,
  sourceId,
  proposalType: "action",
  title,
  createdAt
});
const end = (linkId: string, over: Partial<Parameters<typeof duplicateItems>[0]["deadLinkEnds"][number]> = {}) => ({
  linkId,
  kind: "about",
  linkStatus: "confirmed",
  endType: "action",
  endId: linkId,
  endState: "cancelled",
  ...over
});

describe("duplicateItems", () => {
  it("is empty for a clean slice", () => {
    expect(duplicateItems(slice(), NOW)).toEqual([]);
  });

  it("flags open actions with the same normalised title in one project only", () => {
    const items = duplicateItems(
      slice({
        actions: [
          action("a2", "Buy  milk"),
          action("a1", " buy milk"),
          action("a3", "buy milk", "p2"),
          action("a4", "Other")
        ]
      }),
      NOW
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "duplicate_action:a1",
      check: "duplicate_action",
      tier: "tidy",
      area: "plan",
      handles: ["action:a1", "action:a2"],
      since: day(-3),
      fix: { who: "person" }
    });
  });

  it("does not double-report a group an open finding already names", () => {
    const items = duplicateItems(
      slice({
        actions: [action("a1", "Buy milk"), action("a2", "Buy milk")],
        proposals: [proposal("x1", "Re: Quote", "s1"), proposal("x2", "quote", "s2")],
        openDuplicateFindingItemIds: [
          ["action:a1", "action:a2"],
          ["source:s1", "source:s2"]
        ]
      }),
      NOW
    );
    expect(items).toEqual([]);
  });

  it("flags duplicate pending proposals, ignoring null titles and a fresh inbox", () => {
    const items = duplicateItems(
      slice({
        proposals: [
          proposal("x1", "Re: Quote"),
          proposal("x2", "quote"),
          proposal("n1", null),
          proposal("n2", null),
          proposal("f1", "Fresh", "f1", day(-0.1)),
          proposal("f2", "fresh", "f2", day(-3))
        ]
      }),
      NOW
    );
    expect(items.map((i) => i.id)).toEqual(["duplicate_proposal:x1"]);
    expect(items[0]!.handles).toEqual(["proposal:x1", "proposal:x2"]);
  });

  it("groups links to finished items rather than listing each one", () => {
    const many = Array.from({ length: 40 }, (_, i) => end(`l${String(i).padStart(2, "0")}`));
    const items = duplicateItems(
      slice({
        deadLinkEnds: [
          ...many,
          end("s1", { linkStatus: "suggested", endState: "done" }),
          end("c1", { endState: "done" }),
          end("k1", { kind: "prepares", endState: "archived" }),
          end("k1", { kind: "prepares", endState: "archived", endType: "project", endId: "pr1" })
        ]
      }),
      NOW
    );
    expect(items.map((i) => i.id)).toEqual([
      "link_to_finished:about:confirmed:cancelled",
      "link_to_finished:about:suggested:done",
      "link_to_finished:prepares:confirmed:archived"
    ]);
    expect(items[0]!.title).toContain("40 confirmed");
    expect(items[0]!.handles).toHaveLength(5);
    expect(items[2]!.title).toContain("1 confirmed");
  });

  it("names no tool or command it cannot back", () => {
    const items = duplicateItems(
      slice({ actions: [action("a1", "x"), action("a2", "x")], deadLinkEnds: [end("l1")] }),
      NOW
    );
    for (const item of items) {
      expect(item.fix.tool).toBeUndefined();
      expect(item.fix.cli).toBeUndefined();
    }
  });
});
