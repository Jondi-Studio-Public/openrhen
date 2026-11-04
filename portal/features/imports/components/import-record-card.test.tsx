// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { describe, expect, it, vi } from "vitest";
import type { ImportField, ImportRecord } from "@openrhen/contracts";
import { fireEvent, render, screen } from "@/test/render";
import { sourceRelationships } from "@/features/imports/import-record-source";
import { registerImportHold } from "@/features/imports/import-holds";
import { ImportRecordCard } from "./import-record-card";
import type { PortalState } from "@/state/portal-state";

registerImportHold({
  id: "example",
  isConflictMessage: () => false,
  overlapRelationshipKeys: [],
  overlapErrorPrefixes: [],
  heldCancelKeys: ["senderCancelEdited"],
  heldCancelPrefixes: ["Cancelled by the sender, but "],
  managedRelationshipKeys: ["senderCancelEdited"]
});

const explicit = (value: unknown): ImportField => ({
  value,
  basis: "explicit",
  confidence: "high",
  evidence: [],
  needsReview: false
});

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: "record-1",
    importKey: "action:one",
    entityType: "fixed_commitment_recurrence",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: {},
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...overrides
  };
}

const actions = {
  conditionCatalog: ["home"],
  places: [] as unknown as PortalState["conditionDefinitions"],
  routinePresets: [] as unknown as PortalState["routinePresets"],
  timeBands: [],
  updateField: vi.fn(),
  applyLocation: vi.fn(),
  createCustomLocation: vi.fn(),
  selectRoutine: vi.fn(),
  patchRoutineSteps: vi.fn(),
  updateRelationship: vi.fn(),
  resolveCalendarConflict: vi.fn(),
  applyDefault: vi.fn(),
  toggleRemoved: vi.fn(),
  acceptOverlap: vi.fn(),
  acceptCancel: vi.fn(),
  resolveSourceMatch: vi.fn(),
  dropCommitment: vi.fn()
};

describe("ImportRecordCard", () => {
  it("heads the card with the operation, entity, and key", () => {
    render(<ImportRecordCard {...actions} record={record()} />);
    expect(screen.getByText("create")).toBeTruthy();
    expect(screen.getByText("fixed commitment recurrence · action:one")).toBeTruthy();
  });

  it("shows a message's stored column names and ISO times in plain words", () => {
    render(
      <ImportRecordCard
        {...actions}
        timezone="Australia/Sydney"
        record={record({
          fields: { endsAt: explicit("2026-09-04T10:00:00+10:00") },
          errors: [
            "endsAt must be after startsAt.",
            'Overlaps "Dentist" (2026-09-03T00:00:00.000Z–2026-09-03T01:00:00.000Z).'
          ]
        })}
      />
    );
    expect(screen.getByText("Ends must be after startsAt.")).toBeTruthy();
    expect(
      screen.getByText(/Overlaps "Dentist" \(Thu, 3 Sep\w* at 10:00 am–Thu, 3 Sep\w* at 11:00 am\)\./)
    ).toBeTruthy();
  });

  it("offers Delete anyway and Keep it on a held cancel of an edited commitment", () => {
    const onCancel = vi.fn();
    const onRemove = vi.fn();
    render(
      <ImportRecordCard
        {...actions}
        acceptCancel={onCancel}
        toggleRemoved={onRemove}
        record={record({
          entityType: "fixed_commitment",
          operation: "conflict",
          fields: { title: explicit("Eye test") },
          relationships: { senderCancelEdited: "title" },
          errors: ["Cancelled by the sender, but title changed in OpenRhen since. Delete it anyway or keep it."]
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    expect(onCancel).toHaveBeenCalledWith("record-1");
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onRemove).toHaveBeenCalledWith("record-1");
  });

  it("shows a strong match as a link with only Keep both to undo it", () => {
    const resolveSourceMatch = vi.fn();
    render(
      <ImportRecordCard
        {...actions}
        resolveSourceMatch={resolveSourceMatch}
        record={record({
          entityType: "fixed_commitment",
          operation: "link",
          matchedEntityId: "commitment-1",
          fields: { title: explicit("Work (Harbor Mart)") },
          relationships: {
            sourceMatchKind: "strong",
            sourceMatchCommitmentId: "commitment-1",
            sourceMatchTitle: "Work (Harbor Mart)",
            sourceMatchSpan: "09:00\u201317:00"
          }
        })}
      />
    );
    expect(screen.getByText(/Link to/).textContent).toContain("Work (Harbor Mart), 09:00\u201317:00");
    expect(screen.queryByRole("button", { name: "Same event" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    expect(resolveSourceMatch).toHaveBeenCalledWith("record-1", false);
  });

  it("offers Same event and Keep both on a Possible match", () => {
    const resolveSourceMatch = vi.fn();
    render(
      <ImportRecordCard
        {...actions}
        resolveSourceMatch={resolveSourceMatch}
        record={record({
          entityType: "fixed_commitment",
          operation: "conflict",
          fields: { title: explicit("Jon work") },
          relationships: {
            sourceMatchKind: "possible",
            sourceMatchCommitmentId: "commitment-1",
            sourceMatchTitle: "Work (Harbor Mart)",
            sourceMatchSpan: "09:00\u201317:00"
          },
          errors: [
            "Looks like Work (Harbor Mart), 09:00\u201317:00 (Same times, different title). Choose Same event or Keep both."
          ]
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Same event" }));
    expect(resolveSourceMatch).toHaveBeenCalledWith("record-1", true);
    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    expect(resolveSourceMatch).toHaveBeenLastCalledWith("record-1", false);
    // The screen's own relationships are explained, never offered as text boxes.
    expect(screen.queryByText("sourceMatchKind")).toBeNull();
  });

  it("offers Remove commitment too on an unlink, and Delete anyway on a held Example Shared removal", () => {
    const dropCommitment = vi.fn();
    const acceptCancel = vi.fn();
    const { rerender } = render(
      <ImportRecordCard
        {...actions}
        dropCommitment={dropCommitment}
        record={record({
          entityType: "fixed_commitment",
          operation: "unlink",
          relationships: { sourceUnlinkLinkId: "link-1", sourceUnlinkOthers: "Example Daily" },
          warnings: [
            "Gone from Example Shared, still on Example Daily: remove it? Keeping it drops only the Example Shared link."
          ]
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove commitment too" }));
    expect(dropCommitment).toHaveBeenCalledWith("record-1");
    rerender(
      <ImportRecordCard
        {...actions}
        acceptCancel={acceptCancel}
        record={record({
          entityType: "fixed_commitment",
          operation: "conflict",
          relationships: { remoteCancelEdited: "title" },
          errors: ["Removed from Example Shared, but title changed in OpenRhen since. Delete it anyway or keep it."]
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    expect(acceptCancel).toHaveBeenCalledWith("record-1");
    expect(screen.getByRole("button", { name: "Keep it" })).toBeTruthy();
  });

  it("shows a linking source's disagreement as a per-field choice, with Keep both but no Same event", () => {
    const resolveCalendarConflict = vi.fn();
    render(
      <ImportRecordCard
        {...actions}
        resolveCalendarConflict={resolveCalendarConflict}
        record={record({
          importKey: "example_shared:event:sky-1",
          entityType: "fixed_commitment",
          operation: "conflict",
          matchedEntityId: "commitment-1",
          fields: { startsAt: explicit("2026-08-09T23:30:00.000Z") },
          relationships: {
            sourceMatchKind: "strong",
            sourceMatchCommitmentId: "commitment-1",
            sourceMatchTitle: "Work (Harbor Mart)",
            sourceMatchSpan: "09:00\u201317:00",
            sourceMatchRemoteLabel: "Example Shared",
            sourceMatchConflictFields: "startsAt"
          },
          errors: [
            "startsAt differs from the plan: Example Shared says 09:05, plan has 09:00. Choose which value to keep."
          ]
        })}
      />
    );
    expect(screen.getByText(/Link to/).textContent).toContain("Work (Harbor Mart)");
    expect(screen.queryByRole("button", { name: "Same event" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep both" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use Example Shared" }));
    expect(resolveCalendarConflict).toHaveBeenCalledWith("record-1", "startsAt", true);
    fireEvent.click(screen.getByRole("button", { name: "Keep OpenRhen" }));
    expect(resolveCalendarConflict).toHaveBeenLastCalledWith("record-1", "startsAt", false);
  });

  it("offers Delete anyway and Keep it on a Google cancel of an edited commitment, never as raw fields", () => {
    const onCancel = vi.fn();
    render(
      <ImportRecordCard
        {...actions}
        acceptCancel={onCancel}
        record={record({
          entityType: "fixed_commitment",
          operation: "conflict",
          fields: { title: explicit("Dentist") },
          relationships: { remoteCancelled: "true", remoteCancelEdited: "title" },
          errors: ["Cancelled in Google Calendar, but title changed in OpenRhen since. Delete it anyway or keep it."]
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    expect(onCancel).toHaveBeenCalledWith("record-1");
    expect(screen.getByRole("button", { name: "Keep it" })).toBeTruthy();
    expect(screen.queryByText("remoteCancelled")).toBeNull();
    expect(screen.queryByText("remoteCancelEdited")).toBeNull();
  });

  it("marks a record with errors as ignored rather than confirmed", () => {
    render(<ImportRecordCard {...actions} record={record({ errors: ["title is required"] })} />);
    const chip = screen.getByText("create");
    expect(chip.className).toContain("neutral");
    expect(chip.className).not.toContain("accent");
    expect(screen.getByText("title is required").className).toBe("record-error");
  });

  it("shows warnings without treating them as errors", () => {
    render(<ImportRecordCard {...actions} record={record({ warnings: ["Deadline was inferred"] })} />);
    expect(screen.getByText("Deadline was inferred").className).toBe("record-warning");
  });

  it("switches between removing and restoring a record", () => {
    const toggleRemoved = vi.fn();
    const { rerender, container } = render(
      <ImportRecordCard {...actions} record={record()} toggleRemoved={toggleRemoved} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(toggleRemoved).toHaveBeenCalledWith("record-1");
    rerender(<ImportRecordCard {...actions} record={record({ removed: true })} toggleRemoved={toggleRemoved} />);
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
    expect(container.querySelector("article")!.className).toContain("removed");
  });

  it("edits ordinary relationships but hides the ones the screen manages itself", () => {
    const updateRelationship = vi.fn();
    render(
      <ImportRecordCard
        {...actions}
        record={record({
          relationships: {
            projectKey: "networking-assignment",
            routineSteps: "[]",
            routinePresetId: "preset-1",
            locationProfileId: "campus",
            example_sharedConflictFields: "title"
          }
        })}
        updateRelationship={updateRelationship}
      />
    );
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "clean-room" } });
    expect(updateRelationship).toHaveBeenCalledWith("record-1", "projectKey", "clean-room");
  });

  it("names the row it was read from, and does not offer that address for editing", () => {
    render(
      <ImportRecordCard
        {...actions}
        record={record({ relationships: { projectKey: "p", ...sourceRelationships("Actions", 14) } })}
      />
    );
    expect(screen.getByText("Row 14 · Actions")).toBeTruthy();
    // Only project_key is offered: the sheet and row the record came from are not the reader's to edit.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByText("_sourceRow")).toBeNull();
  });

  it("says nothing about a row for a record no file produced", () => {
    const { container } = render(<ImportRecordCard {...actions} record={record()} />);
    expect(container.querySelector(".import-record-source")).toBeNull();
  });

  it("offers the batch's own keys of the right type when a relationship key is typed", () => {
    const { container } = render(
      <ImportRecordCard
        {...actions}
        batchKeys={{ project: ["networking-assignment", "thesis"], action: ["record-1-key"] }}
        record={record({ relationships: { projectKey: "" } })}
      />
    );
    const input = screen.getByRole("combobox");
    const listId = input.getAttribute("list")!;
    expect(listId).toContain("record-1");
    expect(
      [...container.querySelectorAll(`datalist#${listId} option`)].map((item) => item.getAttribute("value"))
    ).toEqual(["networking-assignment", "thesis"]);
  });

  it("names the record and the day it falls on beside the key the calendar gave it", () => {
    const { container } = render(
      <ImportRecordCard
        {...actions}
        timezone="Australia/Sydney"
        record={record({
          importKey: "example_shared:event:42",
          entityType: "fixed_commitment",
          fields: { title: explicit("Physio"), startsAt: explicit("2026-09-03T09:00:00+10:00") }
        })}
      />
    );
    const headline = container.querySelector(".import-record-headline")!;
    expect(headline.textContent).toBe("PhysioThursday");
    expect(headline.querySelector(".import-record-weekday")!.textContent).toBe("Thursday");
  });

  it("renames the day as soon as the date is edited", () => {
    const commitment = (startsAt: string) =>
      record({
        entityType: "fixed_commitment",
        fields: { title: explicit("Physio"), startsAt: explicit(startsAt) }
      });
    const { container, rerender } = render(
      <ImportRecordCard {...actions} timezone="Australia/Sydney" record={commitment("2026-09-03T09:00:00+10:00")} />
    );
    expect(container.querySelector(".import-record-weekday")!.textContent).toBe("Thursday");
    rerender(
      <ImportRecordCard {...actions} timezone="Australia/Sydney" record={commitment("2026-09-05T09:00:00+10:00")} />
    );
    expect(container.querySelector(".import-record-weekday")!.textContent).toBe("Saturday");
  });

  it("says nothing about a day it cannot read, rather than showing an invalid date", () => {
    const { container } = render(
      <ImportRecordCard
        {...actions}
        timezone="Australia/Sydney"
        record={record({
          entityType: "fixed_commitment",
          fields: { title: explicit("Physio"), startsAt: explicit("2026-09-") }
        })}
      />
    );
    expect(container.querySelector(".import-record-headline")!.textContent).toBe("Physio");
    expect(container.querySelector(".import-record-weekday")).toBeNull();
  });

  it("reads a series by the day its start date names, and says weekly ones in the plural", () => {
    const { container } = render(
      <ImportRecordCard
        {...actions}
        timezone="Australia/Sydney"
        record={record({
          fields: { title: explicit("Choir"), startDate: explicit("2026-09-02"), intervalDays: explicit(7) }
        })}
      />
    );
    expect(container.querySelector(".import-record-weekday")!.textContent).toBe("Wednesdays");
  });

  it("previews a preparation routine for a commitment but not for a recurrence rule", () => {
    const { container, rerender } = render(<ImportRecordCard {...actions} record={record()} />);
    expect(container.querySelector(".routine-preview")).toBeNull();
    rerender(<ImportRecordCard {...actions} record={record({ entityType: "fixed_commitment" })} />);
    expect(container.querySelector(".routine-preview")).toBeTruthy();
    rerender(
      <ImportRecordCard {...actions} record={record({ entityType: "fixed_commitment", operation: "delete" })} />
    );
    expect(container.querySelector(".routine-preview")).toBeNull();
  });
});
