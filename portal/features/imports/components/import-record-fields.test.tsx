// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { describe, expect, it, vi } from "vitest";
import type { ImportField, ImportRecord } from "@openrhen/contracts";
import { fireEvent, render, screen } from "@/test/render";
import { ImportRecordFields } from "./import-record-fields";
import type { PortalState } from "@/state/portal-state";

const explicit = (value: unknown): ImportField => ({
  value,
  basis: "explicit",
  confidence: "high",
  evidence: [],
  needsReview: false
});
const missing: ImportField = { value: null, basis: "missing", confidence: null, evidence: [], needsReview: true };

function record(overrides: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: "record-1",
    importKey: "action:one",
    entityType: "action",
    operation: "create",
    expectedVersion: null,
    matchedEntityId: null,
    fields: { title: explicit("Draft section one") },
    relationships: {},
    errors: [],
    warnings: [],
    removed: false,
    sortOrder: 0,
    ...overrides
  };
}

const places = [
  { id: "campus", name: "Campus", kind: "location", status: "active" },
  { id: "old-flat", name: "Old flat", kind: "location", status: "archived" }
] as unknown as PortalState["conditionDefinitions"];

const props = {
  conditionCatalog: ["home", "laptop"],
  places,
  updateField: vi.fn(),
  applyLocation: vi.fn(),
  createCustomLocation: vi.fn(),
  resolveCalendarConflict: vi.fn(),
  applyDefault: vi.fn()
};

describe("ImportRecordFields", () => {
  it("shows where each value came from and reports an edit", () => {
    const updateField = vi.fn();
    render(<ImportRecordFields {...props} record={record()} updateField={updateField} />);
    expect(screen.getByText("as given")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Renamed" } });
    expect(updateField).toHaveBeenCalledWith("record-1", "title", "Renamed");
  });

  it("offers a default only for a missing field that has one", () => {
    const applyDefault = vi.fn();
    render(
      <ImportRecordFields
        {...props}
        record={record({ fields: { title: missing, energy: missing } })}
        applyDefault={applyDefault}
      />
    );
    expect(screen.getAllByRole("button", { name: "Apply default" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Apply default" }));
    expect(applyDefault).toHaveBeenCalledWith("record-1", "energy");
  });

  it("says when a field's column was not in the file, rather than calling it missing", () => {
    render(
      <ImportRecordFields
        {...props}
        record={record({ fields: { title: { ...missing, needsReview: false, source: "absent" }, energy: missing } })}
      />
    );
    expect(screen.getByText("not in file · left as is")).toBeTruthy();
    expect(screen.getAllByText("blank")).toHaveLength(1);
  });

  it("edits a commitment location through the saved-location list, offering active places only", () => {
    const applyLocation = vi.fn();
    const { container } = render(
      <ImportRecordFields
        {...props}
        record={record({ entityType: "fixed_commitment", fields: { location: explicit("Campus") } })}
        applyLocation={applyLocation}
      />
    );
    expect([...container.querySelectorAll("datalist option")].map((item) => item.getAttribute("value"))).toEqual([
      "Campus"
    ]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Home" } });
    expect(applyLocation).toHaveBeenCalledWith("record-1", "Home");
  });

  it("chooses a commitment's saved place from the active places, keeping an unlisted key visible", () => {
    const updateField = vi.fn();
    render(
      <ImportRecordFields
        {...props}
        record={record({ entityType: "fixed_commitment", fields: { locationId: explicit("campus") } })}
        updateField={updateField}
      />
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].map((option) => [option.value, option.text])).toEqual([
      ["", "—"],
      ["campus", "Campus"]
    ]);
    expect(select.value).toBe("campus");
    fireEvent.change(select, { target: { value: "" } });
    expect(updateField).toHaveBeenCalledWith("record-1", "locationId", "");

    render(
      <ImportRecordFields
        {...props}
        record={record({ entityType: "fixed_commitment", fields: { locationId: explicit("old-flat") } })}
      />
    );
    expect((screen.getAllByRole("combobox").at(-1) as HTMLSelectElement).value).toBe("old-flat");
  });

  it("opens a custom-location popup from the saved-place select, and reports a picked match against this record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ matches: [{ label: "Harbor Mart, Riverside", latitude: -36.1, longitude: 146.9 }] })
      })
    );
    const createCustomLocation = vi.fn().mockResolvedValue(undefined);
    render(
      <ImportRecordFields
        {...props}
        record={record({ entityType: "fixed_commitment", fields: { locationId: explicit("") } })}
        createCustomLocation={createCustomLocation}
      />
    );
    expect(screen.queryByText("Custom location")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Custom location…" }));
    expect(screen.getByText("Custom location")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Type a place, e.g. City Library"), {
      target: { value: "Harbor Mart Riverside" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await vi.waitFor(() => expect(screen.getByText("Harbor Mart, Riverside")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Harbor Mart, Riverside" }));
    await vi.waitFor(() =>
      expect(createCustomLocation).toHaveBeenCalledWith(
        "record-1",
        { label: "Harbor Mart, Riverside", latitude: -36.1, longitude: 146.9 },
        { oneOff: true }
      )
    );
    vi.unstubAllGlobals();
  });

  it("resolves a Example Shared conflict either way", () => {
    const resolveCalendarConflict = vi.fn();
    render(
      <ImportRecordFields
        {...props}
        record={record({
          entityType: "fixed_commitment",
          relationships: { example_sharedConflictFields: "title" }
        })}
        resolveCalendarConflict={resolveCalendarConflict}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep OpenRhen" }));
    expect(resolveCalendarConflict).toHaveBeenCalledWith("record-1", "title", false);
    fireEvent.click(screen.getByRole("button", { name: "Use Example Shared" }));
    expect(resolveCalendarConflict).toHaveBeenLastCalledWith("record-1", "title", true);
  });

  it("names the day beside the date a record is dated by, and beside no other field", () => {
    const { container } = render(
      <ImportRecordFields
        {...props}
        timezone="Australia/Sydney"
        record={record({
          entityType: "fixed_commitment",
          fields: { startsAt: explicit("2026-09-03T09:00:00+10:00"), endsAt: explicit("2026-09-04T10:00:00+10:00") }
        })}
      />
    );
    const days = [...container.querySelectorAll(".import-field-weekday")].map((item) => item.textContent);
    expect(days).toEqual(["Thursday"]);
  });

  it("shows a time as a date and time picker in the batch's zone, and names fields in plain words", () => {
    const { container } = render(
      <ImportRecordFields
        {...props}
        timezone="Australia/Sydney"
        record={record({
          entityType: "fixed_commitment",
          fields: { startsAt: explicit("2026-09-03T09:00:00+10:00"), endsAt: explicit("2026-09-04T10:00:00+10:00") }
        })}
      />
    );
    const times = [...container.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')].map(
      (item) => item.value
    );
    expect(times).toEqual(["2026-09-03T09:00", "2026-09-04T10:00"]);
    expect(screen.getByText("Starts")).toBeTruthy();
    expect(screen.getByText("Ends")).toBeTruthy();
    expect(screen.queryByText("endsAt")).toBeNull();
  });

  it("drops the day when the date is edited into something unreadable", () => {
    const commitment = (startsAt: string) =>
      record({ entityType: "fixed_commitment", fields: { startsAt: explicit(startsAt) } });
    const { container, rerender } = render(
      <ImportRecordFields {...props} timezone="Australia/Sydney" record={commitment("2026-09-03T09:00:00+10:00")} />
    );
    expect(container.querySelector(".import-field-weekday")!.textContent).toBe("Thursday");
    rerender(<ImportRecordFields {...props} timezone="Australia/Sydney" record={commitment("2026-09-0")} />);
    expect(container.querySelector(".import-field-weekday")).toBeNull();
  });

  it("locks every field of a record that has been removed", () => {
    const { container } = render(<ImportRecordFields {...props} record={record({ removed: true })} />);
    expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  });

  it("offers an enum as a choice, a boolean as yes or no, and a blank to clear either", () => {
    const updateField = vi.fn();
    render(
      <ImportRecordFields
        {...props}
        record={record({ fields: { energy: explicit("medium"), splittable: explicit(true) } })}
        updateField={updateField}
      />
    );
    const [energy, splittable] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect([...energy!.options].map((option) => option.value)).toEqual(["", "high", "medium", "low", "recovery"]);
    expect(energy!.value).toBe("medium");
    expect([...splittable!.options].map((option) => option.value)).toEqual(["", "true", "false"]);
    fireEvent.change(energy!, { target: { value: "high" } });
    expect(updateField).toHaveBeenCalledWith("record-1", "energy", "high");
    fireEvent.change(splittable!, { target: { value: "" } });
    expect(updateField).toHaveBeenLastCalledWith("record-1", "splittable", "");
  });

  it("keeps a value the enum does not list selectable, so an invalid cell is shown rather than hidden", () => {
    render(<ImportRecordFields {...props} record={record({ fields: { status: explicit("in_progress") } })} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("in_progress");
  });

  it("offers preferred contexts from the catalogue like the legacy contexts list", () => {
    const updateField = vi.fn();
    render(
      <ImportRecordFields
        {...props}
        record={record({ fields: { preferences: explicit(["home"]) } })}
        updateField={updateField}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "laptop" }));
    expect(updateField).toHaveBeenCalledWith("record-1", "preferences", "home|laptop");
  });

  it("shows requirement pathways in their sheet syntax and hands an edit back as text", () => {
    const updateField = vi.fn();
    render(
      <ImportRecordFields
        {...props}
        record={record({
          fields: { requirementPathways: explicit([{ id: "p1", contextIds: ["desktop", "online"] }]) }
        })}
        updateField={updateField}
      />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("desktop+online");
    fireEvent.change(input, { target: { value: "desktop+online | college" } });
    expect(updateField).toHaveBeenCalledWith("record-1", "requirementPathways", "desktop+online | college");
  });

  it("joins a context list into the pipe-separated value the batch stores", () => {
    const updateField = vi.fn();
    render(
      <ImportRecordFields
        {...props}
        record={record({ fields: { contexts: explicit(["home"]) } })}
        updateField={updateField}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "laptop" }));
    expect(updateField).toHaveBeenCalledWith("record-1", "contexts", "home|laptop");
  });
});
