// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { DEFAULT_FILTERS, applyFilters, buildFlowModel, listRows } from "../data-flow-model";
import { NOW, response, withStaleCalendar } from "../test-fixtures";
import { DataFlowList } from "./data-flow-list";

function rowsFor(data = response()) {
  const model = buildFlowModel(data, { now: NOW });
  const { nodes, edges } = applyFilters(model, DEFAULT_FILTERS);
  return listRows(model, nodes, edges);
}

describe("DataFlowList", () => {
  it("lists problems first, each with a status word, an age and a from, via, to, reaches strip", () => {
    render(<DataFlowList rows={rowsFor(withStaleCalendar())} onSelect={() => {}} />);
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).getByText("Calendar pull")).toBeTruthy();
    expect(within(items[0]!).getByText("Stale · 4 d ago")).toBeTruthy();
    const music = items.find((item) => within(item).queryByText("Music export"))!;
    const strip = within(music).getByLabelText("From, via, to, reaches");
    expect(strip.textContent).toContain("Files you import");
    expect(strip.textContent).toContain("Activity ingest");
    expect(strip.textContent).toContain("gives nothing yet");
    const calendar = items.find((item) => within(item).queryByText("Calendar pull"))!;
    expect(within(calendar).getByLabelText("From, via, to, reaches").textContent).toContain("Planning engine");
  });

  it("never relies on colour alone: every row has its status in text", () => {
    render(<DataFlowList rows={rowsFor()} onSelect={() => {}} />);
    for (const item of screen.getAllByRole("listitem"))
      expect(item.textContent).toMatch(/Fresh|Unused|Planned|Not tracked|Nothing sends|Not set up/);
  });

  it("opens the row's panel when it is pressed", () => {
    const onSelect = vi.fn();
    render(<DataFlowList rows={rowsFor()} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Calendar pull/ }));
    expect(onSelect).toHaveBeenCalledWith("calendar-pull");
  });

  it("marks planned rows as planned", () => {
    render(<DataFlowList rows={rowsFor()} onSelect={() => {}} />);
    const item = screen.getByText("Public holidays").closest("li")!;
    expect(item.getAttribute("data-planned")).toBe("true");
  });

  it("says so when there is nothing to list", () => {
    render(<DataFlowList rows={[]} onSelect={() => {}} />);
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });
});
