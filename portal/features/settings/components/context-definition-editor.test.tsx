// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { ConditionDefinitionEditor, type PlaceLookup } from "@/features/settings/components/context-definition-editor";
import type { ConditionDefinition } from "@/features/settings/context-summary";

const lookup = (overrides: Partial<PlaceLookup> = {}): PlaceLookup => ({
  query: "",
  matches: [],
  looking: false,
  error: "",
  onQueryChange: vi.fn(),
  onLookUp: vi.fn(),
  onSelectMatch: vi.fn(),
  ...overrides
});

const definition = (overrides: Partial<ConditionDefinition> & { id: string; name: string }): ConditionDefinition => ({
  kind: "capability",
  status: "active",
  pathways: [],
  portability: "fixed",
  grants: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  channels: [],
  ...overrides
});

function renderEditor(
  draft: Record<string, unknown>,
  props: Partial<Parameters<typeof ConditionDefinitionEditor>[0]> = {}
) {
  const onChange = vi.fn();
  const view = render(
    <ConditionDefinitionEditor
      draft={draft}
      creating={false}
      definitions={[]}
      routinePresets={[]}
      commitmentRecurrenceRules={[]}
      commitments={[]}
      saving={false}
      lookup={lookup()}
      onChange={onChange}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      {...props}
    />
  );
  return { ...view, onChange };
}

describe("ConditionDefinitionEditor", () => {
  it("offers the id only while creating, because existing ids are pointed at elsewhere", () => {
    renderEditor({ kind: "capability", name: "Desk" });
    expect(screen.queryByLabelText(/^Id/)).toBeNull();
    renderEditor({ kind: "capability", name: "Desk" }, { creating: true });
    expect(screen.getByLabelText(/^Id/)).toBeTruthy();
  });

  it("shows portability for a capability and channels for a contact, and neither for the other kind", () => {
    renderEditor({ kind: "capability", name: "Desk" });
    expect(screen.getByLabelText(/^Portability/)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "in_person" })).toBeNull();
  });

  it("lets a contact be reached by any channel", () => {
    const { onChange } = renderEditor({ kind: "contact", name: "Sam", channels: ["in_person"] });
    fireEvent.click(screen.getByRole("checkbox", { name: "async" }));
    expect(onChange).toHaveBeenCalledWith({ channels: ["in_person", "async"] });
  });

  it("edits a contact's phone and email, and refuses to save one that doesn't look right", () => {
    const { onChange, unmount } = renderEditor({ kind: "contact", name: "Sam", channels: [] });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "0400 123 456" } });
    expect(onChange).toHaveBeenCalledWith({ phone: "0400 123 456" });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "sam@example.com" } });
    expect(onChange).toHaveBeenCalledWith({ email: "sam@example.com" });
    unmount();
    renderEditor({ kind: "contact", name: "Sam", channels: [], email: "sam@" });
    expect(screen.getByText("That email address doesn't look right.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers phone and email only for a contact", () => {
    renderEditor({ kind: "capability", name: "Desk" });
    expect(screen.queryByLabelText("Phone")).toBeNull();
  });

  it("keeps portable capabilities out of what a place can grant", () => {
    renderEditor(
      { kind: "location", name: "Home", grants: [] },
      {
        definitions: [
          definition({ id: "desk", name: "Desk" }),
          definition({ id: "phone", name: "Phone", portability: "portable" }),
          definition({ id: "campus", name: "Campus", kind: "location" })
        ]
      }
    );
    expect(screen.getByText("desk")).toBeTruthy();
    expect(screen.queryByText("phone")).toBeNull();
    expect(screen.queryByText("campus")).toBeNull();
  });

  it("clears coordinates to null rather than leaving a stale pair behind", () => {
    const { onChange } = renderEditor({ kind: "location", name: "Home", latitude: -36.1, longitude: 146.9 });
    expect(screen.getByText(/Set to -36\.10000, 146\.90000/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith({ latitude: null, longitude: null, address: null });
  });

  it("defaults a place's usual mode to no opinion, and reports a choice or a clear back to it", () => {
    const { onChange } = renderEditor({ kind: "location", name: "Home" });
    const field = screen.getByLabelText(/^Usual mode/) as HTMLSelectElement;
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "bike" } });
    expect(onChange).toHaveBeenCalledWith({ usualTransportMode: "bike" });
    onChange.mockClear();
    fireEvent.change(field, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({ usualTransportMode: null });
  });

  it("offers no usual mode field for anything but a location", () => {
    renderEditor({ kind: "capability", name: "Desk" });
    expect(screen.queryByLabelText(/^Usual mode/)).toBeNull();
  });

  it("names the place a stored address describes, and falls back to bare coordinates without one", () => {
    renderEditor({
      kind: "location",
      name: "Harbor Mart",
      latitude: -36.12345,
      longitude: 146.88123,
      address: "Harbor Mart, Riverside"
    });
    expect(screen.getByText(/Set to Harbor Mart, Riverside \(-36\.12345, 146\.88123\)/)).toBeTruthy();
    renderEditor({ kind: "location", name: "Harbor Mart", latitude: -36.12345, longitude: 146.88123 });
    expect(screen.getByText(/Set to -36\.12345, 146\.88123\./)).toBeTruthy();
  });

  it("drops the address the moment a coordinate is typed by hand, which it no longer describes", () => {
    const { onChange } = renderEditor({
      kind: "location",
      name: "Harbor Mart",
      latitude: -36.1,
      longitude: 146.9,
      address: "Harbor Mart, Riverside"
    });
    fireEvent.change(screen.getByPlaceholderText("latitude"), { target: { value: "-37.5" } });
    expect(onChange).toHaveBeenCalledWith({ latitude: -37.5, address: null });
    fireEvent.change(screen.getByPlaceholderText("longitude"), { target: { value: "147.2" } });
    expect(onChange).toHaveBeenLastCalledWith({ longitude: 147.2, address: null });
  });

  it("cannot search on an empty query and surfaces a lookup failure", () => {
    render(
      <ConditionDefinitionEditor
        draft={{ kind: "location", name: "Home" }}
        creating={false}
        definitions={[]}
        routinePresets={[]}
        commitmentRecurrenceRules={[]}
        commitments={[]}
        saving={false}
        lookup={lookup({ error: "The lookup failed." })}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect((screen.getByRole("button", { name: "Find" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("The lookup failed.")).toBeTruthy();
  });

  it("will not let a new place be saved until it says where it actually is", () => {
    renderEditor({ kind: "location", name: "Harbor Mart" }, { creating: true });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/travel can't be measured without it/)).toBeTruthy();
  });

  it("releases the save as soon as a whole coordinate pair is present", () => {
    renderEditor({ kind: "location", name: "Harbor Mart", latitude: -36.1, longitude: 146.9 }, { creating: true });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/travel can't be measured without it/)).toBeNull();
  });

  it("still lets an existing coordinate-less place be edited, since that is how it gets fixed", () => {
    renderEditor({ kind: "location", name: "Harbor Mart" });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks nothing of a new capability, which has nowhere to be", () => {
    renderEditor({ kind: "capability", name: "Desk" }, { creating: true });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hands a chosen match back whole, so the manager can set both coordinates at once", () => {
    const onSelectMatch = vi.fn();
    const match = { label: "Harbor Mart Riverside", latitude: -36.1, longitude: 146.9 };
    render(
      <ConditionDefinitionEditor
        draft={{ kind: "location", name: "Home" }}
        creating={false}
        definitions={[]}
        routinePresets={[]}
        commitmentRecurrenceRules={[]}
        commitments={[]}
        saving={false}
        lookup={lookup({ query: "Harbor Mart", matches: [match], onSelectMatch })}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Harbor Mart Riverside" }));
    expect(onSelectMatch).toHaveBeenCalledWith(match);
  });

  it("has no status select with an Archived option; the status is text and the close control sits beside it", () => {
    renderEditor({ kind: "capability", name: "Desk", status: "active" }, {
      closeControl: <button type="button">Archive context</button>
    });
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Archived" })).toBeNull();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive context" })).toBeTruthy();
  });

  it("shows an archived context as Archived, and offers no close control while creating or for the home base", () => {
    const control = <button type="button">Archive context</button>;
    const { unmount } = renderEditor({ kind: "capability", name: "Desk", status: "archived" }, { closeControl: control });
    expect(screen.getByText("Archived")).toBeTruthy();
    unmount();
    const creating = renderEditor({ kind: "capability", name: "Desk" }, { creating: true, closeControl: control });
    expect(screen.queryByRole("button", { name: "Archive context" })).toBeNull();
    creating.unmount();
    renderEditor({ kind: "location", name: "Home" }, { homeLocked: true, closeControl: control });
    expect(screen.queryByRole("button", { name: "Archive context" })).toBeNull();
    expect(screen.getByText("This is your home base. Choose another home base first.")).toBeTruthy();
  });
});
