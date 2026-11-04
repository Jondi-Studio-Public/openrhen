import "@/test/example-calendar-sources";
import { describe, expect, it } from "vitest";
import type { ImportRecord } from "@openrhen/contracts";
import { emptyProposalDraft } from "@/features/capture/proposal-draft";
import type { ProposalDraft } from "@/features/capture/proposals";
import type { PortalState } from "@/state/portal-state";
import { batchEffect, batchLines, captureEffect, projectChoices } from "./plan-effect";

const field = (value: unknown) => ({
  value,
  basis: "explicit" as const,
  confidence: "high" as const,
  evidence: [] as string[],
  needsReview: false
});

const record = (patch: Partial<ImportRecord> = {}): ImportRecord =>
  ({
    id: "r",
    importKey: "example_shared:event:1",
    entityType: "fixed_commitment",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: { title: field("Swim squad") },
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...patch
  }) as ImportRecord;

const task = (patch: Partial<ImportRecord> = {}) => record({ importKey: "csv:row:1", entityType: "action", ...patch });

describe("batchEffect", () => {
  it("says a batch with nothing selected changes nothing", () => {
    expect(batchEffect([])).toBe("Nothing is selected, so committing it changes nothing.");
    expect(batchEffect([record({ removed: true }), task({ removed: true })])).toBe(
      "Nothing is selected, so committing it changes nothing."
    );
  });

  it("counts a conflicting record as needing a fix, and says nothing can be added when every record does", () => {
    expect(batchEffect([record({ operation: "conflict" })])).toBe(
      "Nothing here can be added yet. 1 needs a fix first."
    );
    expect(batchEffect([record({ operation: "conflict" }), record({ id: "b", errors: ["Bad date"] as never })])).toBe(
      "Nothing here can be added yet. 2 need a fix first."
    );
  });

  it("does not count a rejected record without errors as blocking, but it writes nothing", () => {
    expect(batchEffect([record({ operation: "rejected" })])).toBe(
      "Nothing here can be added yet. Choose Change first to resolve it."
    );
    expect(batchEffect([record({ operation: "rejected" }), record({ id: "b", operation: "rejected" })])).toBe(
      "Nothing here can be added yet. Choose Change first to resolve it."
    );
  });

  it("counts a rejected record that has errors as needing a fix", () => {
    expect(batchEffect([record({ operation: "rejected", errors: ["Bad"] as never })])).toBe(
      "Nothing here can be added yet. 1 needs a fix first."
    );
  });

  it("counts only the records that can be written, and ends with how many need a fix", () => {
    expect(
      batchEffect([
        record(),
        record({ id: "b" }),
        record({ id: "c", errors: ["Missing time"] as never }),
        record({ id: "d", operation: "conflict" })
      ])
    ).toBe("Adds 2 events to your calendar. 2 need a fix first.");
    expect(batchEffect([task(), task({ id: "b", errors: ["No project"] as never })])).toBe(
      "Adds 1 item to your plan. 1 needs a fix first."
    );
  });

  it("leaves a removed record that has errors out of the fix count", () => {
    expect(batchEffect([record(), record({ id: "b", removed: true, errors: ["Bad"] as never })])).toBe(
      "Adds 1 event to your calendar. Nothing is written until you add it."
    );
  });

  it("skips removed records when counting", () => {
    expect(batchEffect([record(), record({ id: "b" }), record({ id: "c", removed: true })])).toBe(
      "Adds 2 events to your calendar. Nothing is written until you add it."
    );
  });

  it("words by entity type: commitments are events whatever their import key, anything else is an item", () => {
    expect(batchEffect([record({ importKey: "csv:row:1" })])).toBe(
      "Adds 1 event to your calendar. Nothing is written until you add it."
    );
    expect(batchEffect([record({ entityType: "fixed_commitment_recurrence", importKey: "csv:row:2" })])).toBe(
      "Adds 1 event to your calendar. Nothing is written until you add it."
    );
    expect(batchEffect([task({ importKey: "example_shared:event:1" })])).toBe(
      "Adds 1 item to your plan. Nothing is written until you add it."
    );
  });

  it("uses event wording when every kept record is a calendar event", () => {
    expect(batchEffect([record()])).toBe("Adds 1 event to your calendar. Nothing is written until you add it.");
    expect(
      batchEffect([
        record({ importKey: "google_calendar:event:9" }),
        record({ id: "b", importKey: "example_daily:shift:2" })
      ])
    ).toBe("Adds 2 events to your calendar. Nothing is written until you add it.");
  });

  it("uses item wording when any kept record is not a calendar event", () => {
    expect(batchEffect([task()])).toBe("Adds 1 item to your plan. Nothing is written until you add it.");
    expect(batchEffect([record(), task({ id: "b" })])).toBe(
      "Adds 2 items to your plan. Nothing is written until you add it."
    );
  });

  it("goes back to calendar wording once the one non-calendar record is removed", () => {
    expect(batchEffect([record(), task({ id: "b", removed: true })])).toBe(
      "Adds 1 event to your calendar. Nothing is written until you add it."
    );
  });

  it("joins several operations with commas and a final and", () => {
    expect(batchEffect([record(), record({ id: "b", operation: "update" })])).toBe(
      "Adds 1 event to your calendar and updates 1 event. Nothing is written until you add it."
    );
    expect(
      batchEffect([
        task({ id: "a", operation: "create" }),
        task({ id: "b", operation: "update" }),
        task({ id: "c", operation: "update" }),
        task({ id: "d", operation: "delete" })
      ])
    ).toBe("Adds 1 item to your plan, updates 2 items and removes 1 item. Nothing is written until you add it.");
  });

  it("words link, unlink and delete", () => {
    expect(batchEffect([task({ operation: "link" })])).toBe(
      "Links 1 item to ones already in your plan. Nothing is written until you add it."
    );
    expect(batchEffect([task({ operation: "unlink" })])).toBe("Unlinks 1 item. Nothing is written until you add it.");
    expect(batchEffect([record({ operation: "delete" }), record({ id: "b", operation: "delete" })])).toBe(
      "Removes 2 events. Nothing is written until you add it."
    );
  });
});

describe("batchLines", () => {
  it("lists kept records by title, skipping removed ones", () => {
    expect(batchLines([task({ fields: { title: field("Pay rego") } }), task({ id: "b", removed: true })])).toEqual([
      "Pay rego"
    ]);
  });

  it("adds the weekday a dated record falls on, in the batch's zone", () => {
    const dated = record({ fields: { title: field("Swim squad"), startsAt: field("2026-10-01T22:55:00.000Z") } });
    expect(batchLines([dated], "Australia/Sydney")).toEqual(["Swim squad · Friday"]);
    expect(batchLines([dated], "UTC")).toEqual(["Swim squad · Thursday"]);
  });

  it("names a weekly series by its plural weekday", () => {
    const series = record({
      entityType: "fixed_commitment_recurrence",
      importKey: "example_shared:series:1",
      fields: { title: field("Squad"), startDate: field("2026-10-06"), intervalDays: field(7) }
    });
    expect(batchLines([series])).toEqual(["Squad · Tuesdays"]);
  });

  it("falls back to Untitled for a record with no title", () => {
    expect(batchLines([task({ fields: {} }), task({ id: "b", fields: { title: field("  ") } })])).toEqual([
      "Untitled",
      "Untitled"
    ]);
  });
});

const projects = [
  { id: "p1", title: "Packing", status: "active" },
  { id: "p2", title: "Move house", status: "active" },
  { id: "p3", title: "Tax", status: "active" },
  { id: "p4", title: "Garden", status: "active" },
  { id: "p5", title: "Old thing", status: "completed" }
] as unknown as PortalState["projects"];

const state = {
  projects,
  outcomes: [{ id: "o1", title: "Finish the diploma" }],
  areas: [{ id: "a1", name: "Home" }]
} as unknown as Pick<PortalState, "projects" | "outcomes" | "areas">;

const draft = (patch: Partial<ProposalDraft>): ProposalDraft => ({ ...emptyProposalDraft(), ...patch });

describe("captureEffect", () => {
  it("returns null while the capture has not been sorted", () => {
    expect(captureEffect(draft({ proposalType: "unclassified", title: "Thing" }), state)).toBeNull();
  });

  it.each([
    [
      "an action under its project",
      { proposalType: "action", title: "Pack boxes", projectId: "p1" },
      "Adds the action “Pack boxes” under Packing."
    ],
    [
      "an action with no project",
      { proposalType: "action", title: "Pack boxes" },
      "Adds the action “Pack boxes” once you say which project it belongs to."
    ],
    [
      "an action whose project is unknown",
      { proposalType: "action", title: "Pack boxes", projectId: "gone" },
      "Adds the action “Pack boxes” once you say which project it belongs to."
    ],
    [
      "a deliverable under its project",
      { proposalType: "deliverable", title: "Folio", projectId: "p2" },
      "Adds the deliverable “Folio” under Move house."
    ],
    [
      "a deliverable with no project",
      { proposalType: "deliverable", title: "Folio" },
      "Adds the deliverable “Folio” once you say which project it belongs to."
    ],
    [
      "an outcome in an area",
      { proposalType: "outcome", title: "Be fit", areaId: "a1" },
      "Adds the outcome “Be fit” in Home."
    ],
    ["an outcome with no area", { proposalType: "outcome", title: "Be fit" }, "Adds the outcome “Be fit”."],
    [
      "a project under an outcome",
      { proposalType: "project", title: "Camp", outcomeId: "o1" },
      "Starts the project “Camp” under Finish the diploma."
    ],
    ["a project with no outcome", { proposalType: "project", title: "Camp" }, "Starts the project “Camp”."],
    ["a fixed commitment", { proposalType: "fixed_commitment", title: "Dentist" }, "Adds “Dentist” to your calendar."],
    [
      "a someday item",
      { proposalType: "someday", title: "Sail" },
      "Files “Sail” under Kept for later. It is not offered as work."
    ],
    [
      "a reference item",
      { proposalType: "reference", title: "Wifi code" },
      "Files “Wifi code” under Kept for later. It is not offered as work."
    ]
  ] as const)("says %s", (_name, patch, sentence) => {
    expect(captureEffect(draft(patch as Partial<ProposalDraft>), state)).toBe(sentence);
  });

  it("calls an untitled draft “this”", () => {
    expect(captureEffect(draft({ proposalType: "fixed_commitment", title: "   " }), state)).toBe(
      "Adds “this” to your calendar."
    );
  });
});

describe("projectChoices", () => {
  const ids = (choices: { id: string }[]) => choices.map((choice) => choice.id);

  it("offers the chosen project first, then the suggested one, then active projects", () => {
    expect(ids(projectChoices({ projectId: "p3" }, "p2", projects))).toEqual(["p3", "p2", "p1"]);
  });

  it("offers the suggestion first when nothing is chosen", () => {
    expect(ids(projectChoices({ projectId: "" }, "p4", projects))).toEqual(["p4", "p1", "p2"]);
  });

  it("does not offer a project twice", () => {
    expect(ids(projectChoices({ projectId: "p1" }, "p1", projects))).toEqual(["p1", "p2", "p3"]);
  });

  it("stops at the limit, three by default", () => {
    expect(projectChoices({ projectId: "" }, null, projects)).toHaveLength(3);
    expect(ids(projectChoices({ projectId: "" }, null, projects, 2))).toEqual(["p1", "p2"]);
    expect(ids(projectChoices({ projectId: "" }, null, projects, 10))).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("leaves out projects that are not active, unless chosen or suggested", () => {
    expect(ids(projectChoices({ projectId: "" }, null, projects, 10))).not.toContain("p5");
    expect(ids(projectChoices({ projectId: "p5" }, null, projects))).toEqual(["p5", "p1", "p2"]);
  });

  it("skips a chosen or suggested id that is not a project", () => {
    expect(ids(projectChoices({ projectId: "gone" }, "also-gone", projects))).toEqual(["p1", "p2", "p3"]);
  });

  it("returns the title with each id", () => {
    expect(projectChoices({ projectId: "p2" }, null, projects, 1)).toEqual([{ id: "p2", title: "Move house" }]);
  });

  it("is empty when there are no projects", () => {
    expect(projectChoices({ projectId: "" }, null, [])).toEqual([]);
  });
});
