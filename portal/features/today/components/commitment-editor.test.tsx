// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PlanningSettings, StoredCommitment, StoredProject } from "@/state/portal-state";
import type { ConditionDefinition } from "@/features/settings/context-summary";
import { emptyCommitmentEditor } from "@/features/today/today-drafts";
import { act, fireEvent, render, screen } from "@/test/render";
import { CommitmentEditor } from "./commitment-editor";

const openCaptureSheetMock = vi.fn();
vi.mock("@/shared/use-capture-sheet", () => ({
  openCaptureSheet: (...args: unknown[]) => openCaptureSheetMock(...args)
}));

const settings = {
  defaultSetupBufferMinutes: 10,
  defaultTransitionBufferMinutes: 15
} as unknown as PlanningSettings;
const projects = [
  { id: "study", title: "Semester two" },
  { id: "home", title: "Reset the room" }
] as unknown as StoredProject[];
const definitions = [
  { id: "campus", name: "Campus", kind: "location", status: "active", travelMinutes: 18 },
  { id: "house", name: "Home", kind: "location", status: "active" },
  { id: "shed", name: "Old shed", kind: "location", status: "archived" },
  { id: "dentist", name: "Dentist, Riverside", kind: "location", status: "active", oneOff: true }
] as unknown as ConditionDefinition[];
const draft = emptyCommitmentEditor(settings);
const noCreate = () => Promise.reject(new Error("not expected"));

const editor = (overrides: Partial<Parameters<typeof CommitmentEditor>[0]> = {}) => (
  <CommitmentEditor
    draft={draft}
    onChange={() => {}}
    onSubmit={() => {}}
    onCancel={() => {}}
    onCreatePlaceFromSearch={noCreate}
    onCreateContact={noCreate}
    projects={projects}
    definitions={definitions}
    timezone="Australia/Sydney"
    {...overrides}
  />
);

describe("Commitment editor", () => {
  it("starts as a one-off with the buffer defaults and an unchecked Repeats toggle", () => {
    render(editor());
    expect(screen.getByText("Add commitment")).toBeTruthy();
    expect((screen.getByLabelText("Repeats") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Setup before (minutes)") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Transition after (minutes)") as HTMLInputElement).value).toBe("15");
    expect(screen.getByLabelText("Starts")).toBeTruthy();
    expect(screen.queryByLabelText("First occurrence date")).toBeNull();
  });

  it("defaults presence to fully occupied and reports the choice for both halves of the editor", () => {
    const onChange = vi.fn();
    const { unmount } = render(editor({ onChange }));
    const field = screen.getByLabelText("While there") as HTMLSelectElement;
    expect(field.value).toBe("blocking");
    fireEvent.change(field, { target: { value: "anchor" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, presence: "anchor" });
    unmount();
    // A repeating rule asks the same question: presence belongs to the commitment, not to the way it
    // was created, and every occurrence the rule materialises copies the answer.
    const repeating = { ...draft, repeats: true };
    render(editor({ draft: repeating, onChange }));
    fireEvent.change(screen.getByLabelText("While there"), { target: { value: "anchor" } });
    expect(onChange).toHaveBeenCalledWith({ ...repeating, presence: "anchor" });
  });

  it("defaults check-in prompts to normal, reports a change, and hides the field for a repeating rule", () => {
    const onChange = vi.fn();
    const { unmount } = render(editor({ onChange }));
    const field = screen.getByLabelText("Check-in prompts") as HTMLSelectElement;
    expect(field.value).toBe("normal");
    fireEvent.change(field, { target: { value: "silent" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, promptPolicy: "silent" });
    unmount();
    // Prompt policy lives on the stored commitment row, not the recurring rule, so a repeating series
    // has nowhere of its own to hold it.
    render(editor({ draft: { ...draft, repeats: true } }));
    expect(screen.queryByLabelText("Check-in prompts")).toBeNull();
  });

  it("reports the Repeats toggle, which swaps the dated block for the rule fields", () => {
    const onChange = vi.fn();
    render(editor({ onChange }));
    fireEvent.click(screen.getByLabelText("Repeats"));
    expect(onChange).toHaveBeenCalledWith({ ...draft, repeats: true });
  });

  it("keeps a whole-week days count when the unit switches to weeks: every 14 days becomes every 2 weeks", () => {
    const onChange = vi.fn();
    render(editor({ draft: { ...draft, repeats: true, intervalDays: 14 }, onChange }));
    fireEvent.change(screen.getByLabelText("Repeat unit"), { target: { value: "weeks" } });
    expect(onChange).toHaveBeenCalledWith({
      ...draft,
      repeats: true,
      intervalDays: 14,
      repeatUnit: "weeks",
      intervalWeeks: 2
    });
  });

  it("shows the rule fields and the rule status once Repeats is on", () => {
    render(editor({ draft: { ...draft, repeats: true } }));
    expect(screen.queryByLabelText("Starts")).toBeNull();
    expect((screen.getByLabelText("Repeats every (days)") as HTMLInputElement).value).toBe("7");
    expect((screen.getByLabelText("Local start time") as HTMLInputElement).value).toBe("09:00");
    expect((screen.getByLabelText("Local end time") as HTMLInputElement).value).toBe("10:00");
    expect(screen.getByLabelText("Last date (optional)")).toBeTruthy();
    const status = screen.getByLabelText("Status") as HTMLSelectElement;
    expect([...status.options].map((option) => option.value)).toEqual(["active", "ended"]);
  });

  it("reports a retyped title, a chosen project and a rule end date back to the caller", () => {
    const onChange = vi.fn();
    render(editor({ onChange, draft: { ...draft, repeats: true } }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Networking class" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, repeats: true, title: "Networking class" });

    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "home" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, repeats: true, projectId: "home" });

    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("Last date (optional)"), { target: { value: "2026-12-01" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, repeats: true, endDate: "2026-12-01" });
  });

  it("locks the Repeats toggle away once an existing record is being edited", () => {
    render(editor({ draft: { ...draft, id: "class" } }));
    expect(screen.getByText("Edit commitment")).toBeTruthy();
    expect(screen.queryByLabelText("Repeats")).toBeNull();
  });

  it("opens a stored series with the rule fields and no way to unrepeat it", () => {
    render(editor({ draft: { ...draft, id: "weekly", repeats: true, startDate: "2026-08-18" } }));
    expect(screen.getByText("Edit recurring commitment")).toBeTruthy();
    expect(screen.queryByLabelText("Repeats")).toBeNull();
    expect((screen.getByLabelText("First occurrence date") as HTMLInputElement).value).toBe("2026-08-18");
  });

  it("sets the place and its label together through the picker", () => {
    const onChange = vi.fn();
    render(editor({ onChange }));
    const place = screen.getByLabelText("Place") as HTMLSelectElement;
    expect([...place.options].map((option) => option.textContent)).toEqual(["— none —", "Campus", "Home"]);
    fireEvent.change(place, { target: { value: "campus" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, locationId: "campus", location: "Campus" });
  });

  it("names the commitment a one-off would collide with, but never warns a series", () => {
    const overlapCommitment = {
      id: "dentist",
      title: "Dentist",
      startsAt: "2026-08-18T00:00:00.000Z",
      endsAt: "2026-08-18T01:00:00.000Z",
      status: "confirmed",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0
    } as unknown as StoredCommitment;
    render(editor({ overlapCommitment }));
    expect(screen.getByText(/This conflicts with “Dentist”/)).toBeTruthy();
  });

  it("defaults lateness matters to on and travel mode to usual, and reports a change to either", () => {
    const onChange = vi.fn();
    render(editor({ onChange }));
    const lateness = screen.getByLabelText("Lateness matters") as HTMLInputElement;
    expect(lateness.checked).toBe(true);
    fireEvent.click(lateness);
    expect(onChange).toHaveBeenCalledWith({ ...draft, latenessMatters: false });

    const mode = screen.getByLabelText("Travel by") as HTMLSelectElement;
    expect(mode.value).toBe("");
    fireEvent.change(mode, { target: { value: "bike" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, transportMode: "bike" });
  });

  it("lists active contacts and reports a chosen one, for a one-off, an occurrence and a series", () => {
    const contactDefinitions = [
      ...definitions,
      { id: "sam", name: "Sam", kind: "contact", status: "active", channels: [] }
    ] as unknown as ConditionDefinition[];
    const onChange = vi.fn();
    const { unmount } = render(editor({ onChange, definitions: contactDefinitions }));
    const contact = screen.getByLabelText("Contact") as HTMLSelectElement;
    expect([...contact.options].map((option) => option.textContent)).toEqual(["— none —", "Sam"]);
    fireEvent.change(contact, { target: { value: "sam" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, contactId: "sam" });
    unmount();

    onChange.mockClear();
    const occurrence = render(editor({ onChange, definitions: contactDefinitions, draft: { ...draft, id: "class" } }));
    fireEvent.change(screen.getByLabelText("Contact"), { target: { value: "sam" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, id: "class", contactId: "sam" });
    occurrence.unmount();

    onChange.mockClear();
    render(editor({ onChange, definitions: contactDefinitions, draft: { ...draft, repeats: true } }));
    fireEvent.change(screen.getByLabelText("Contact"), { target: { value: "sam" } });
    expect(onChange).toHaveBeenCalledWith({ ...draft, repeats: true, contactId: "sam" });
  });

  it("submits through the caller's handler", () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(editor({ onSubmit, draft: { ...draft, id: "class" } }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps a cancel confirmation on screen for a resolvable contact, and opens the sheet with it", () => {
    const contactDefinitions = [
      ...definitions,
      { id: "sam", name: "Sam", kind: "contact", status: "active", channels: [] }
    ] as unknown as ConditionDefinition[];
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      editor({
        onSubmit,
        definitions: contactDefinitions,
        draft: {
          ...draft,
          id: "class",
          title: "Dentist",
          startsAt: "2026-09-10T10:00",
          status: "cancelled",
          contactId: "sam"
        }
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Cancelled.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Let Sam know?" }));
    expect(openCaptureSheetMock).toHaveBeenCalledWith("disruption", {
      contactId: "sam",
      reason: "cancelled",
      about: "Dentist at 10:00 am"
    });
  });

  it("closes as today when cancelling without a resolvable contact", () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      editor({
        onSubmit,
        draft: { ...draft, id: "class", status: "cancelled", contactId: "" }
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.queryByText("Cancelled.")).toBeNull();
  });

  it("toggles the Private switch", () => {
    const onChange = vi.fn();
    render(editor({ onChange }));
    fireEvent.click(screen.getByLabelText("Private"));
    expect(onChange).toHaveBeenCalledWith({ ...draft, private: true });
  });

  describe("hand entry: already on your plan", () => {
    const match = {
      kind: "strong" as const,
      id: "existing one",
      title: "Harbor Mart shift",
      startsAt: "2026-09-29T23:00:00.000Z"
    };

    it("names the commitment and its time, and offers Open it and Save anyway", () => {
      const onSaveAnyway = vi.fn();
      render(editor({ handEntryMatch: match, onSaveAnyway }));
      const notice = screen.getByRole("status");
      expect(notice.textContent).toContain("Already on your plan: Harbor Mart shift, 9:00");
      expect(screen.getByRole("link", { name: "Open it" }).getAttribute("href")).toBe("/commitments/existing%20one");
      fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
      expect(onSaveAnyway).toHaveBeenCalledTimes(1);
    });

    it("routes Save anyway through the submit guard: a second tap is swallowed and the button disabled until it settles", async () => {
      let release: () => void = () => {};
      const onSaveAnyway = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
      render(editor({ handEntryMatch: match, onSaveAnyway }));
      const button = screen.getByRole("button", { name: "Save anyway" }) as HTMLButtonElement;
      fireEvent.click(button);
      fireEvent.click(button);
      expect(onSaveAnyway).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(true);
      await act(async () => release());
      await act(async () => {});
      expect(button.disabled).toBe(false);
    });

    it("never blocks: the form can still be submitted with the notice showing", () => {
      const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
      const { container } = render(editor({ handEntryMatch: match, onSubmit }));
      fireEvent.submit(container.querySelector("form")!);
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("shows nothing without a match, while editing, or for a repeating rule", () => {
      const { unmount } = render(editor({ handEntryMatch: null }));
      expect(screen.queryByText(/Already on your plan/)).toBeNull();
      unmount();
      const { unmount: again } = render(editor({ handEntryMatch: match, draft: { ...draft, id: "existing" } }));
      expect(screen.queryByText(/Already on your plan/)).toBeNull();
      again();
      render(editor({ handEntryMatch: match, draft: { ...draft, repeats: true } }));
      expect(screen.queryByText(/Already on your plan/)).toBeNull();
    });
  });
});
