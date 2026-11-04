// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { emptyOutcome } from "@/features/plan/plan-drafts";
import { OutcomeEditor } from "@/features/plan/components/outcome-editor";

const seed = () => createSeedState(new Date("2026-08-18T09:00:00.000Z"));

describe("OutcomeEditor", () => {
  it("asks which area an outcome belongs to before naming any of them", () => {
    render(
      <OutcomeEditor
        draft={emptyOutcome()}
        areas={seed().areas}
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    const options = screen.getAllByRole<HTMLOptionElement>("option");
    expect(options[0]!.textContent).toBe("Choose area");
    expect(options.map((option) => option.textContent)).toContain("Study");
  });

  it("offers no archived area for new work, but keeps the one an outcome already sits in", () => {
    const areas = seed().areas.map((area) => (area.name === "Study" ? { ...area, status: "archived" as const } : area));
    const archivedId = areas.find((area) => area.name === "Study")!.id;
    const names = () => screen.getAllByRole<HTMLOptionElement>("option").map((option) => option.textContent);
    const { rerender } = render(
      <OutcomeEditor draft={emptyOutcome()} areas={areas} onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} />
    );
    expect(names()).not.toContain("Study");
    rerender(
      <OutcomeEditor
        draft={{ ...emptyOutcome(), areaId: archivedId }}
        areas={areas}
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(names()).toContain("Study");
  });

  it("keeps the value a number so the stored score never becomes text", () => {
    const onChange = vi.fn();
    render(
      <OutcomeEditor
        draft={emptyOutcome()}
        areas={seed().areas}
        onChange={onChange}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    fireEvent.change(screen.getByLabelText("Value (1–5)"), { target: { value: "5" } });
    expect(onChange).toHaveBeenCalledWith({ ...emptyOutcome(), value: 5 });
  });

  it("records the definition of done that decides the outcome is finished", () => {
    const onChange = vi.fn();
    render(
      <OutcomeEditor
        draft={emptyOutcome()}
        areas={seed().areas}
        onChange={onChange}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    fireEvent.change(screen.getByLabelText("Definition of done"), { target: { value: "Floor clear" } });
    expect(onChange).toHaveBeenCalledWith({ ...emptyOutcome(), definitionOfDone: "Floor clear" });
  });

  it("offers no archived or cancelled status, and shows a closed outcome's status as text without a select", () => {
    const props = { areas: seed().areas, onChange: () => {}, onSubmit: () => {}, onCancel: () => {} };
    const { rerender } = render(<OutcomeEditor draft={{ ...emptyOutcome(), id: "o1", title: "Tidy" }} {...props} />);
    const statusSelect = screen.getByRole<HTMLSelectElement>("combobox", { name: "Status" });
    expect(Array.from(statusSelect.options).map((option) => option.textContent)).toEqual(["active", "paused", "done"]);
    rerender(<OutcomeEditor draft={{ ...emptyOutcome(), id: "o1", title: "Tidy", status: "cancelled" }} {...props} />);
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull();
    expect(screen.getByText("cancelled")).toBeTruthy();
  });

  it("shows the close control only for an outcome that exists", () => {
    const control = <button type="button">Close outcome…</button>;
    const props = {
      areas: seed().areas,
      onChange: () => {},
      onSubmit: () => {},
      onCancel: () => {},
      closeControl: control
    };
    const { rerender } = render(<OutcomeEditor draft={emptyOutcome()} {...props} />);
    expect(screen.queryByRole("button", { name: "Close outcome…" })).toBeNull();
    rerender(<OutcomeEditor draft={{ ...emptyOutcome(), id: "o1", title: "Tidy" }} {...props} />);
    expect(screen.getByRole("button", { name: "Close outcome…" })).toBeTruthy();
  });
});
