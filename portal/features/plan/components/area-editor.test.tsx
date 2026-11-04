// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { emptyArea } from "@/features/plan/plan-drafts";
import { AreaEditor } from "@/features/plan/components/area-editor";

describe("AreaEditor", () => {
  it("opens by itself once an existing area has been loaded into it", () => {
    const { container, rerender } = render(
      <AreaEditor draft={emptyArea()} onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} />
    );
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getByText("Add an area")).toBeTruthy();
    rerender(
      <AreaEditor
        draft={{ ...emptyArea(), id: "area-home", name: "Home" }}
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(container.querySelector("details")?.open).toBe(true);
    expect(screen.getByText("Edit area")).toBeTruthy();
  });

  it("reports a typed name as a whole draft rather than a loose field", () => {
    const onChange = vi.fn();
    render(<AreaEditor draft={emptyArea()} onChange={onChange} onSubmit={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Music" } });
    expect(onChange).toHaveBeenCalledWith({ ...emptyArea(), name: "Music" });
  });

  it("submits the form and cancels an edit through its own callbacks", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <AreaEditor
        draft={{ ...emptyArea(), id: "area-home", name: "Home" }}
        onChange={() => {}}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    fireEvent.submit(container.querySelector("form")!);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("toggles the Private switch", () => {
    const onChange = vi.fn();
    render(<AreaEditor draft={emptyArea()} onChange={onChange} onSubmit={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByLabelText("Private"));
    expect(onChange).toHaveBeenCalledWith({ ...emptyArea(), private: true });
  });

  it("offers no archived or cancelled status, and shows a closed area's status as text without a select", () => {
    const props = { onChange: () => {}, onSubmit: () => {}, onCancel: () => {} };
    const { rerender } = render(<AreaEditor draft={{ ...emptyArea(), id: "a1", name: "Home" }} {...props} />);
    const statusSelect = screen.getByRole<HTMLSelectElement>("combobox", { name: "Status" });
    expect(Array.from(statusSelect.options).map((option) => option.textContent)).toEqual(["active", "paused", "done"]);
    rerender(<AreaEditor draft={{ ...emptyArea(), id: "a1", name: "Home", status: "archived" }} {...props} />);
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull();
    expect(screen.getByText("archived")).toBeTruthy();
  });

  it("shows the close control only for an area that exists", () => {
    const control = <button type="button">Archive area</button>;
    const props = { onChange: () => {}, onSubmit: () => {}, onCancel: () => {}, closeControl: control };
    const { rerender } = render(<AreaEditor draft={emptyArea()} {...props} />);
    expect(screen.queryByRole("button", { name: "Archive area" })).toBeNull();
    rerender(<AreaEditor draft={{ ...emptyArea(), id: "a1", name: "Home" }} {...props} />);
    expect(screen.getByRole("button", { name: "Archive area" })).toBeTruthy();
  });
});
