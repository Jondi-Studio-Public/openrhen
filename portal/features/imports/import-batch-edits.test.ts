import "@/test/example-calendar-sources";
import { describe, expect, it } from "vitest";
import type { ImportBatch, ImportRecord } from "@openrhen/contracts";
import {
  acceptRecordCancel,
  acceptRecordOverlap,
  applyBlankDefaults,
  applyRecordDefault,
  applyRecordLocation,
  countBlankDefaults,
  countBlockingImportRecords,
  dropRecordCommitment,
  filterImportRecords,
  importKeysByType,
  patchRecordRoutineSteps,
  removeBlockingRecords,
  resolveRecordSourceMatch,
  resolveRecordSharedCalendarConflict,
  selectRecordRoutine,
  setCalendarSelection,
  toggleRecordRemoved,
  updateRecordField,
  updateRecordRelationship
} from "./import-batch-edits";
import { registerImportHold } from "./import-holds";
import { parseImportCsv } from "./import-csv";
import { validateImportRecords } from "./import-validation";
import type { PortalState } from "@/state/portal-state";

// A hold as an extension registers it; the generic review reads only these answers.
registerImportHold({
  id: "example",
  isConflictMessage: (message) =>
    message.startsWith("Cancelled by the sender, but ") || message.startsWith("Held for your review: "),
  overlapRelationshipKeys: ["senderOverlap", "senderHold"],
  overlapErrorPrefixes: ["Held for your review: "],
  heldCancelKeys: ["senderCancelEdited"],
  heldCancelPrefixes: ["Cancelled by the sender, but "],
  managedRelationshipKeys: ["senderOverlap", "senderHold", "senderCancelEdited"]
});

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    importKey: "action:one",
    entityType: "action",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: { title: { value: "One", basis: "explicit", confidence: "high", evidence: [], needsReview: false } },
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...overrides
  };
}

function batchOf(records: ImportRecord[]): ImportBatch {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    sourceType: "csv",
    inputKind: "planning_data",
    timezone: "Australia/Sydney",
    templateVersion: "1",
    status: "ready",
    version: 3,
    records,
    source: {}
  };
}

describe("filterImportRecords", () => {
  const records = [
    record({ id: "ready" }),
    record({ id: "missing-title", errors: ["title is required"] }),
    record({ id: "warned", warnings: ["Guessed the deadline"] }),
    record({ id: "dropped", removed: true })
  ];

  it("returns everything for the all filter", () => {
    expect(filterImportRecords(records, "all")).toHaveLength(4);
  });

  it("treats clean, kept records as ready", () => {
    expect(filterImportRecords(records, "ready").map((item) => item.id)).toEqual(["ready"]);
  });

  it("separates required-field failures, warnings, and rejections", () => {
    expect(filterImportRecords(records, "needs").map((item) => item.id)).toEqual(["missing-title"]);
    expect(filterImportRecords(records, "warnings").map((item) => item.id)).toEqual(["warned"]);
    expect(filterImportRecords(records, "rejected").map((item) => item.id)).toEqual(["missing-title", "dropped"]);
  });
});

describe("countBlockingImportRecords", () => {
  it("counts kept records that are invalid or conflicting", () => {
    const count = countBlockingImportRecords([
      record({ id: "a", errors: ["title is required"] }),
      record({ id: "b", operation: "conflict" }),
      record({ id: "c", operation: "rejected", errors: ["title is required"] }),
      record({ id: "d", errors: ["title is required"], removed: true }),
      record({ id: "e" })
    ]);
    expect(count).toBe(3);
  });

  it("stops counting a record the browser has just put right, though the store still calls it rejected", () => {
    expect(countBlockingImportRecords([record({ operation: "rejected", errors: [] })])).toBe(0);
  });
});

describe("record edits", () => {
  it("drops a validated batch back to draft when a field changes", () => {
    const next = updateRecordField(batchOf([record()]), "11111111-1111-4111-8111-111111111111", "title", "Renamed");
    expect(next.status).toBe("draft");
    expect(next.records[0]!.fields.title!.value).toBe("Renamed");
  });

  it("ignores a default for a field that has none", () => {
    const batch = batchOf([record()]);
    expect(applyRecordDefault(batch, "11111111-1111-4111-8111-111111111111", "title")).toBe(batch);
  });

  it("lists the keys the batch would write by entity type, leaving out removed and unkeyed rows", () => {
    const records = [
      record(),
      { ...record({ id: "22222222-2222-4222-8222-222222222222", importKey: "proj" }), entityType: "project" as const },
      record({ id: "33333333-3333-4333-8333-333333333333", importKey: "gone", removed: true }),
      record({ id: "44444444-4444-4444-8444-444444444444", importKey: "missing-action-2" })
    ];
    expect(importKeysByType(records)).toEqual({ action: [record().importKey], project: ["proj"] });
  });

  it("applies needs_breakdown rather than active when a deliverable status is defaulted", () => {
    const batch = batchOf([record({ entityType: "deliverable" })]);
    const next = applyRecordDefault(batch, "11111111-1111-4111-8111-111111111111", "status");
    expect(next.records[0]!.fields.status).toMatchObject({ value: "needs_breakdown", basis: "default" });
  });

  it("toggles removal and trims relationship values to null when blank", () => {
    const batch = batchOf([record()]);
    expect(toggleRecordRemoved(batch, "11111111-1111-4111-8111-111111111111").records[0]!.removed).toBe(true);
    const related = updateRecordRelationship(batch, "11111111-1111-4111-8111-111111111111", "projectId", "  ");
    expect(related.records[0]!.relationships.projectId).toBeNull();
  });

  it("selects and clears every calendar record at once", () => {
    const calendar = record({
      id: "cal",
      entityType: "fixed_commitment",
      importKey: "example_shared:event:1",
      removed: true
    });
    const cleared = setCalendarSelection(batchOf([calendar]), true);
    expect(cleared.records[0]!.removed).toBe(false);
    expect(setCalendarSelection(cleared, false).records[0]!.removed).toBe(true);
  });
});

describe("applyRecordLocation", () => {
  const defaults = {
    conditionDefinitions: [
      {
        id: "campus",
        name: "Campus",
        kind: "location",
        status: "active",
        pathways: [],
        portability: "fixed",
        grants: [],
        setupBeforeMinutes: 20,
        transitionAfterMinutes: 25,
        defaultRoutinePresetId: "preset-1",
        channels: []
      }
    ] as unknown as PortalState["conditionDefinitions"],
    routinePresets: [
      { id: "preset-1", name: "Leave for campus", steps: [{ id: "step-1", title: "Pack bag" }] }
    ] as unknown as PortalState["routinePresets"],
    defaultSetupBufferMinutes: 10,
    defaultTransitionBufferMinutes: 5
  };

  it("carries the saved buffers and default routine onto the record", () => {
    const next = applyRecordLocation(
      batchOf([record({ entityType: "fixed_commitment" })]),
      "11111111-1111-4111-8111-111111111111",
      " campus ",
      defaults
    );
    const [updated] = next.records;
    expect(updated!.fields.setupBeforeMinutes).toMatchObject({ value: 20, basis: "default" });
    expect(updated!.fields.transitionAfterMinutes!.value).toBe(25);
    expect(updated!.relationships.locationProfileId).toBe("campus");
    // Naming the place also chooses it, so the label and the place key cannot drift apart.
    expect(updated!.fields.locationId).toMatchObject({ value: "campus", basis: "explicit" });
    expect(updated!.relationships.routinePresetId).toBe("preset-1");
    expect(JSON.parse(updated!.relationships.routineSteps!)).toHaveLength(1);
  });

  it("falls back to the global buffers for an unknown place", () => {
    const next = applyRecordLocation(
      batchOf([record({ entityType: "fixed_commitment" })]),
      "11111111-1111-4111-8111-111111111111",
      "Nowhere",
      defaults
    );
    expect(next.records[0]!.fields.setupBeforeMinutes!.value).toBe(10);
    expect(next.records[0]!.relationships.routinePresetId).toBeNull();
  });

  it("writes a known id straight through, even when the place is not yet in the local catalogue", () => {
    const next = applyRecordLocation(
      batchOf([record({ entityType: "fixed_commitment" })]),
      "11111111-1111-4111-8111-111111111111",
      "Just created",
      defaults,
      "fresh-place"
    );
    const updated = next.records[0]!;
    expect(updated.fields.locationId!.value).toBe("fresh-place");
    expect(updated.relationships.locationProfileId).toBe("fresh-place");
    // Still not found by name, so the global buffers apply rather than a profile's own.
    expect(updated.fields.setupBeforeMinutes!.value).toBe(10);
  });

  it("looks a known id up by id rather than by matching the label against a name", () => {
    const next = applyRecordLocation(
      batchOf([record({ entityType: "fixed_commitment" })]),
      "11111111-1111-4111-8111-111111111111",
      'Somewhere I typed, not "Campus"',
      defaults,
      "campus"
    );
    const updated = next.records[0]!;
    expect(updated.fields.locationId!.value).toBe("campus");
    expect(updated.fields.setupBeforeMinutes!.value).toBe(20);
    expect(updated.relationships.routinePresetId).toBe("preset-1");
  });

  it("clears the routine when the preset selection is emptied", () => {
    const chosen = selectRecordRoutine(
      batchOf([record({ entityType: "fixed_commitment" })]),
      "11111111-1111-4111-8111-111111111111",
      "preset-1",
      defaults.routinePresets
    );
    expect(chosen.records[0]!.relationships.routinePresetId).toBe("preset-1");
    const cleared = selectRecordRoutine(chosen, "11111111-1111-4111-8111-111111111111", "", defaults.routinePresets);
    expect(cleared.records[0]!.relationships.routineSteps).toBeNull();
    const emptied = patchRecordRoutineSteps(chosen, "11111111-1111-4111-8111-111111111111", []);
    expect(emptied.records[0]!.relationships.routineSteps).toBeNull();
  });
});

describe("resolveRecordSharedCalendarConflict", () => {
  const conflicted = record({
    entityType: "fixed_commitment",
    operation: "conflict",
    fields: {
      title: { value: "Local title", basis: "explicit", confidence: "high", evidence: [], needsReview: false }
    },
    relationships: { example_sharedConflictFields: "title|startsAt", "example_sharedRemote:title": '"Remote title"' },
    errors: ["title changed in both places"]
  });

  it("takes the remote value and leaves the record conflicted while a field remains", () => {
    const next = resolveRecordSharedCalendarConflict(
      batchOf([conflicted]),
      "11111111-1111-4111-8111-111111111111",
      "title",
      true
    );
    const [updated] = next.records;
    expect(updated!.fields.title!.value).toBe("Remote title");
    expect(updated!.relationships.example_sharedConflictFields).toBe("startsAt");
    expect(updated!.relationships["example_sharedRemote:title"]).toBeNull();
    expect(updated!.operation).toBe("conflict");
    expect(updated!.errors).not.toContain("title changed in both places");
  });

  it("keeps the local value and becomes an ordinary update once nothing is left to decide", () => {
    const single = record({
      entityType: "fixed_commitment",
      operation: "conflict",
      fields: { title: { value: "Local", basis: "explicit", confidence: "high", evidence: [], needsReview: false } },
      relationships: { example_sharedConflictFields: "title", "example_sharedRemote:title": '"Remote"' }
    });
    const next = resolveRecordSharedCalendarConflict(
      batchOf([single]),
      "11111111-1111-4111-8111-111111111111",
      "title",
      false
    );
    expect(next.records[0]!.fields.title!.value).toBe("Local");
    expect(next.records[0]!.operation).toBe("update");
    expect(next.records[0]!.relationships.example_sharedConflictFields).toBeNull();
  });
});

describe("resolveRecordSharedCalendarConflict for a Example Daily roster record", () => {
  it("reads and clears the example_daily-prefixed keys so a roster conflict resolves like a Example Shared one", () => {
    const rostered = record({
      importKey: "example_daily:shift:28093820",
      entityType: "fixed_commitment",
      operation: "conflict",
      fields: { title: { value: "Local", basis: "explicit", confidence: "high", evidence: [], needsReview: false } },
      relationships: { example_dailyConflictFields: "title", "example_dailyRemote:title": '"Work (Harbor Mart)"' }
    });
    const next = resolveRecordSharedCalendarConflict(
      batchOf([rostered]),
      "11111111-1111-4111-8111-111111111111",
      "title",
      true
    );
    expect(next.records[0]!.fields.title!.value).toBe("Work (Harbor Mart)");
    expect(next.records[0]!.operation).toBe("update");
    expect(next.records[0]!.relationships.example_dailyConflictFields).toBeNull();
    expect(next.records[0]!.relationships["example_dailyRemote:title"]).toBeNull();
  });
});

describe("revalidation on every edit", () => {
  const actionCsv = (status: string) =>
    parseImportCsv(
      "actions",
      "import_key,project_key,title,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,importance,consequence\r\n" +
        `one,proj,One,${status},20,30,45,30,medium,15,30,true,0,5,5`
    )[0]!;

  it("clears a required-field error as soon as the field is filled in", () => {
    const blank = actionCsv("");
    const batch = batchOf([{ ...blank, errors: ["status is required."] }]);
    expect(countBlockingImportRecords(batch.records)).toBe(1);
    const fixed = updateRecordField(batch, blank.id, "status", "active");
    expect(fixed.records[0]!.errors).toEqual([]);
    expect(countBlockingImportRecords(fixed.records)).toBe(0);
  });

  it("raises an error the moment an edit breaks a rule, without waiting for the server", () => {
    const valid = actionCsv("active");
    const broken = updateRecordField(batchOf([valid]), valid.id, "expectedMinutes", "5");
    expect(broken.records[0]!.errors).toContain("Effort must follow optimistic ≤ expected ≤ pessimistic.");
  });

  it("keeps the findings only the store could have made, since the browser cannot re-judge them", () => {
    const valid = actionCsv("active");
    const batch = batchOf([
      { ...valid, errors: ["projectKey does not resolve to an imported or previously mapped project."] }
    ]);
    const edited = updateRecordField(batch, valid.id, "title", "Renamed");
    expect(edited.records[0]!.errors).toEqual([
      "projectKey does not resolve to an imported or previously mapped project."
    ]);
  });

  it("leaves the operation alone: what a record will do is the server's answer, not the browser's", () => {
    const valid = actionCsv("active");
    const batch = batchOf([{ ...valid, operation: "update" as const, errors: ["status is required."] }]);
    const edited = updateRecordField(batch, valid.id, "title", "Renamed");
    expect(edited.records[0]!.operation).toBe("update");
    expect(edited.records[0]!.errors).toEqual([]);
  });

  it("drops the batch to draft, so an edited batch can never be committed on the browser's word", () => {
    const valid = actionCsv("active");
    expect(updateRecordField(batchOf([valid]), valid.id, "title", "Renamed").status).toBe("draft");
  });
});

describe("bulk edits", () => {
  const blankAction = () =>
    parseImportCsv("actions", "import_key,project_key,title,status,splittable,setup_minutes\r\none,proj,One,,,")[0]!;

  it("counts the blank fields a column default could fill", () => {
    // status, splittable, setup_minutes, energy, importance and consequence all carry a default.
    expect(countBlankDefaults([blankAction()])).toBe(6);
    expect(countBlankDefaults([])).toBe(0);
  });

  it("counts nothing for a record that is on its way out", () => {
    expect(countBlankDefaults([{ ...blankAction(), removed: true }])).toBe(0);
    expect(countBlankDefaults([{ ...blankAction(), operation: "delete" }])).toBe(0);
  });

  it("fills every blank that has a default, and marks each as a default the user accepted", () => {
    const action = blankAction();
    const filled = applyBlankDefaults(batchOf([action]), [action]);
    expect(filled.records[0]!.fields.status).toMatchObject({ value: "active", basis: "default", source: "cell" });
    expect(filled.records[0]!.fields.splittable!.value).toBe(true);
    expect(filled.records[0]!.fields.setupMinutes!.value).toBe(0);
    // A field with no default of its own is still the author's problem.
    expect(filled.records[0]!.fields.expectedMinutes!.value).toBeNull();
    expect(countBlankDefaults(filled.records)).toBe(0);
  });

  it("touches only the records it was given, so a filter decides the button's reach", () => {
    const shown = blankAction();
    const hidden = { ...blankAction(), id: "99999999-9999-4999-8999-999999999999" };
    const filled = applyBlankDefaults(batchOf([shown, hidden]), [shown]);
    expect(filled.records[0]!.fields.status!.value).toBe("active");
    expect(filled.records[1]!.fields.status!.value).toBeNull();
  });

  it("returns the batch untouched when there is nothing to fill", () => {
    const batch = batchOf([record()]);
    expect(applyBlankDefaults(batch, batch.records)).toBe(batch);
  });

  it("removes the records that still block, and leaves the rest kept", () => {
    const blocked = { ...blankAction(), errors: ["status is required."] };
    const clean = parseImportCsv("areas", "import_key,name,description,status,sort_order\r\nstudy,Study,,active,0")[0]!;
    const next = removeBlockingRecords(batchOf([blocked, clean]), [blocked, clean]);
    expect(next.records.map((item) => item.removed)).toEqual([true, false]);
    expect(countBlockingImportRecords(next.records)).toBe(0);
  });

  it("removes rather than deletes, so the decision can be taken back one row at a time", () => {
    const blocked = { ...blankAction(), errors: ["status is required."] };
    const next = removeBlockingRecords(batchOf([blocked]), [blocked]);
    expect(next.records).toHaveLength(1);
    expect(toggleRecordRemoved(next, blocked.id).records[0]!.removed).toBe(false);
  });

  it("returns the batch untouched when nothing in view is blocking", () => {
    const batch = batchOf([record()]);
    expect(removeBlockingRecords(batch, batch.records)).toBe(batch);
  });
});

describe("column presence under edits", () => {
  it("turns an absent column into a cell once the user types into it, and keeps it a cell when cleared", () => {
    const absent = record({
      fields: {
        title: { value: null, basis: "missing", confidence: null, evidence: [], needsReview: false, source: "absent" }
      }
    });
    const typed = updateRecordField(batchOf([absent]), absent.id, "title", "Named");
    expect(typed.records[0]!.fields.title).toMatchObject({ value: "Named", source: "cell" });
    const cleared = updateRecordField(typed, absent.id, "title", "");
    expect(cleared.records[0]!.fields.title).toMatchObject({ value: null, basis: "missing", source: "cell" });
  });
});

describe("a sender's repeating entry held for review (K2)", () => {
  const held = record({
    importKey: "example:c:event-1",
    entityType: "fixed_commitment_recurrence",
    operation: "conflict",
    fields: Object.fromEntries(
      Object.entries({
        title: "Shift",
        timezone: "Australia/Sydney",
        startDate: "2026-10-12",
        endDate: null,
        intervalUnit: "days",
        intervalDays: 1,
        localStartTime: "00:00",
        localEndTime: "23:59",
        location: null,
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }).map(([name, value]) => [
        name,
        { value, basis: "explicit", confidence: "high", evidence: ["Sender portal"], needsReview: false }
      ])
    ) as ImportRecord["fields"],
    relationships: {
      senderHold: "it repeats 56 times in the next 8 weeks",
      senderOverlap: JSON.stringify({ code: "overlap", commitmentId: "c-1", title: "Dentist" })
    },
    errors: [
      'Overlaps "Dentist" (a\u2013b), and maybe other dates of this repeat.',
      "Held for your review: it repeats 56 times in the next 8 weeks."
    ]
  });

  it("stays a held conflict through validation, errors intact", () => {
    const [validated] = validateImportRecords([held]);
    expect(validated!.operation).toBe("conflict");
    expect(validated!.errors).toEqual(held.errors);
  });

  it("goes back to a create on Apply anyway, with neither the overlap nor the hold left", () => {
    const batch = { id: "batch", version: 1, records: [held] } as unknown as ImportBatch;
    const released = acceptRecordOverlap(batch, held.id).records[0]!;
    expect(released.operation).toBe("create");
    expect(released.errors).toEqual([]);
    expect(released.relationships).toEqual({});
    expect(validateImportRecords([released])[0]!.errors).toEqual([]);
  });

  it("goes back to an update, not a create, when it was a change to a rule", () => {
    const change = { ...held, matchedEntityId: "rule-1" };
    const batch = { id: "batch", version: 1, records: [change] } as unknown as ImportBatch;
    expect(acceptRecordOverlap(batch, change.id).records[0]!.operation).toBe("update");
  });
});

describe("acceptRecordCancel", () => {
  const held = record({
    importKey: "example:c:event-1",
    entityType: "fixed_commitment",
    operation: "conflict",
    matchedEntityId: "commitment-1",
    expectedVersion: 3,
    fields: Object.fromEntries(
      Object.entries({
        title: "Eye test, bring glasses",
        startsAt: "2026-09-10T04:00:00.000Z",
        endsAt: "2026-09-10T05:00:00.000Z",
        status: "confirmed",
        location: null,
        setupBeforeMinutes: 0,
        transitionAfterMinutes: 0
      }).map(([name, value]) => [
        name,
        { value, basis: "explicit", confidence: "high", evidence: ["Cancelled by the sender"], needsReview: false }
      ])
    ) as ImportRecord["fields"],
    relationships: { senderCancelEdited: "title" },
    errors: ["Cancelled by the sender, but title changed in OpenRhen since. Delete it anyway or keep it."]
  });

  it("keeps a sender's cancel of an edited commitment held through validation", () => {
    const [validated] = validateImportRecords([held]);
    expect(validated!.operation).toBe("conflict");
    expect(validated!.errors).toEqual(held.errors);
  });

  it("releases the held cancel back to a delete on Delete anyway", () => {
    const batch = { id: "batch", version: 1, records: [held] } as unknown as ImportBatch;
    const released = acceptRecordCancel(batch, held.id).records[0]!;
    expect(released.operation).toBe("delete");
    expect(released.errors).toEqual([]);
    expect(released.relationships.senderCancelEdited).toBeUndefined();
    expect(validateImportRecords([released])[0]!.errors).toEqual([]);
  });

  it("releases a Google delete held because the commitment was edited here, keeping it a cancel", () => {
    const google = {
      ...held,
      importKey: "google_calendar:event:jon@example.com:e1",
      relationships: { remoteCancelled: "true", remoteCancelEdited: "title" },
      errors: ["Cancelled in Google Calendar, but title changed in OpenRhen since. Delete it anyway or keep it."]
    };
    expect(validateImportRecords([google])[0]!.operation).toBe("conflict");
    const batch = { id: "batch", version: 1, records: [google] } as unknown as ImportBatch;
    const released = acceptRecordCancel(batch, google.id).records[0]!;
    expect(released.operation).toBe("delete");
    expect(released.errors).toEqual([]);
    expect(released.relationships).toEqual({ remoteCancelled: "true" });
    expect(validateImportRecords([released])[0]!.errors).toEqual([]);
  });

  it("releases a Google delete held because its event left the calendar", () => {
    const missing = {
      ...held,
      importKey: "google_calendar:event:jon@example.com:e2",
      relationships: { remoteCancelEdited: "location" },
      errors: [
        "No longer on this Google calendar for this date range, but location changed in OpenRhen since. Delete it anyway or keep it."
      ]
    };
    const batch = { id: "batch", version: 1, records: [missing] } as unknown as ImportBatch;
    const released = acceptRecordCancel(batch, missing.id).records[0]!;
    expect(released).toMatchObject({ operation: "delete", errors: [], relationships: {} });
  });
});

describe("source matching edits", () => {
  const field = (value: unknown) => ({
    value,
    basis: "explicit" as const,
    confidence: "high" as const,
    evidence: [],
    needsReview: false
  });
  const possible = record({
    importKey: "example_shared:event:sky-1",
    entityType: "fixed_commitment",
    operation: "conflict",
    fields: {
      title: field("Jon work"),
      startsAt: field("2026-08-09T23:30:00.000Z"),
      endsAt: field("2026-08-10T07:30:00.000Z"),
      status: field("confirmed"),
      setupBeforeMinutes: field(0),
      transitionAfterMinutes: field(0)
    },
    relationships: {
      sourceMatchKind: "possible",
      sourceMatchCommitmentId: "commitment-1",
      sourceMatchTitle: "Work (Harbor Mart)"
    },
    errors: [
      "Looks like Work (Harbor Mart), 09:00\u201317:00 (Same times, different title). Choose Same event or Keep both."
    ]
  });

  it("holds a Possible row through validation until it is answered", () => {
    const [validated] = validateImportRecords([possible]);
    expect(validated!.operation).toBe("conflict");
    expect(validated!.errors).toEqual(possible.errors);
  });

  it("turns Same event into a link to the matched commitment and lifts the hold", () => {
    const linked = resolveRecordSourceMatch(batchOf([possible]), possible.id, true).records[0]!;
    expect(linked.operation).toBe("link");
    expect(linked.matchedEntityId).toBe("commitment-1");
    expect(linked.errors).toEqual([]);
    expect(linked.relationships.sourceMatchKind).toBe("possible");
  });

  it("turns Keep both back into the create it was, forgetting the match", () => {
    const created = resolveRecordSourceMatch(batchOf([possible]), possible.id, false).records[0]!;
    expect(created.operation).toBe("create");
    expect(created.matchedEntityId).toBeNull();
    expect(created.errors).toEqual([]);
    expect(Object.keys(created.relationships).filter((name) => name.startsWith("sourceMatch"))).toEqual([]);
  });

  it("turns an unlink into the delete of the commitment on Remove commitment too", () => {
    const unlink = record({
      entityType: "fixed_commitment",
      operation: "unlink",
      matchedEntityId: "commitment-1",
      relationships: { sourceUnlinkLinkId: "link-1", sourceUnlinkOthers: "Example Daily" }
    });
    const [validated] = validateImportRecords([unlink]);
    expect(validated!.operation).toBe("unlink");
    const dropped = dropRecordCommitment(batchOf([unlink]), unlink.id).records[0]!;
    expect(dropped.operation).toBe("delete");
    expect(dropped.relationships.sourceUnlinkLinkId).toBeUndefined();
    // the link stays named, so the commit remembers this source's removal; and the row says it cancels, not deletes
    expect(dropped.relationships.sourceLinkId).toBe("link-1");
    expect(dropped.warnings.join(" ")).toContain("cancels the commitment");
    expect(dropped.warnings.join(" ")).not.toContain("permanently");
  });
});

describe("a source joining with differing values", () => {
  const f = (value: unknown) => ({
    value,
    basis: "explicit" as const,
    confidence: "high" as const,
    evidence: [],
    needsReview: false
  });
  const possible = record({
    importKey: "example_shared:event:sky-1",
    entityType: "fixed_commitment",
    operation: "conflict",
    fields: {
      title: f("Jon work"),
      startsAt: f("2026-08-09T23:35:00.000Z"),
      endsAt: f("2026-08-10T07:30:00.000Z"),
      status: f("confirmed"),
      setupBeforeMinutes: f(0),
      transitionAfterMinutes: f(0)
    },
    relationships: {
      sourceMatchKind: "possible",
      sourceMatchCommitmentId: "commitment-1",
      sourceMatchTitle: "Work (Harbor Mart)",
      sourceMatchRemoteLabel: "Example Shared",
      sourceMatchTimezone: "Australia/Adelaide",
      sourceMatchDiffFields: "title|startsAt",
      "sourceMatchPlan:title": JSON.stringify("Work (Harbor Mart)"),
      "sourceMatchRemote:title": JSON.stringify("Jon work"),
      "sourceMatchPlan:startsAt": JSON.stringify("2026-08-09T23:30:00.000Z"),
      "sourceMatchRemote:startsAt": JSON.stringify("2026-08-09T23:35:00.000Z")
    },
    errors: ["Looks like Work (Harbor Mart), 09:00 (Same times, different title). Choose Same event or Keep both."]
  });

  it("asks per field after Same event, showing the plan's values and nothing preselected", () => {
    const asked = resolveRecordSourceMatch(batchOf([possible]), possible.id, true).records[0]!;
    expect(asked.operation).toBe("conflict");
    expect(asked.relationships.sourceMatchConflictFields).toBe("title|startsAt");
    expect(asked.fields.title!.value).toBe("Work (Harbor Mart)");
    expect(asked.errors).toContain(
      "startsAt differs from the plan: Example Shared says 09:05, plan has 09:00. Choose which value to keep."
    );
    expect(validateImportRecords([asked])[0]!.operation).toBe("conflict");
  });

  it("becomes the link once every field is answered, carrying the picked values", () => {
    let batch = resolveRecordSourceMatch(batchOf([possible]), possible.id, true);
    batch = resolveRecordSharedCalendarConflict(batch, possible.id, "title", true);
    expect(batch.records[0]!.operation).toBe("conflict");
    batch = resolveRecordSharedCalendarConflict(batch, possible.id, "startsAt", false);
    const linked = batch.records[0]!;
    expect(linked.operation).toBe("link");
    expect(linked.errors).toEqual([]);
    expect(linked.fields.title!.value).toBe("Jon work");
    expect(linked.fields.startsAt!.value).toBe("2026-08-09T23:30:00.000Z");
    // The remote's own values survive for the link's snapshot however the choice went.
    expect(linked.relationships["sourceMatchRemote:startsAt"]).toBe(JSON.stringify("2026-08-09T23:35:00.000Z"));
  });

  it("keeps the target commitment when the server had cleared it from the held record", () => {
    let batch = resolveRecordSourceMatch(batchOf([possible]), possible.id, true);
    // The store once nulled matchedEntityId on a conflict with no import key.
    batch = { ...batch, records: batch.records.map((item) => ({ ...item, matchedEntityId: null })) };
    batch = resolveRecordSharedCalendarConflict(batch, possible.id, "title", false);
    batch = resolveRecordSharedCalendarConflict(batch, possible.id, "startsAt", false);
    expect(batch.records[0]).toMatchObject({ operation: "link", matchedEntityId: "commitment-1" });
  });

  it("restores the remote's values on Keep both", () => {
    let batch = resolveRecordSourceMatch(batchOf([possible]), possible.id, true);
    batch = resolveRecordSourceMatch(batch, possible.id, false);
    const created = batch.records[0]!;
    expect(created.operation).toBe("create");
    expect(created.fields.title!.value).toBe("Jon work");
    expect(created.errors).toEqual([]);
  });
});
