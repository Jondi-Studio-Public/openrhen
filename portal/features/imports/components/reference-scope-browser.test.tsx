// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { ReferenceScopeBrowser } from "./reference-scope-browser";

const state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));

describe("ReferenceScopeBrowser", () => {
  it("starts at the root and walks into a folder", () => {
    render(<ReferenceScopeBrowser state={state} selected={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Enter · 2" })[0]!);
    expect(screen.getByText(/Study/)).toBeTruthy();
    expect(screen.queryByText(/Fixed commitments/)).toBeNull();
  });

  it("filters the current folder by the search box", () => {
    render(<ReferenceScopeBrowser state={state} selected={[]} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "commitments" } });
    expect(screen.getByText(/Fixed commitments/)).toBeTruthy();
    expect(screen.queryByText(/Entire plan/)).toBeNull();
  });

  it("reports an empty folder search rather than an empty list", () => {
    render(<ReferenceScopeBrowser state={state} selected={[]} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nothing here" } });
    expect(screen.getByText("No records match this folder search.")).toBeTruthy();
  });

  it("adds a ticked scope and removes it again", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ReferenceScopeBrowser state={state} selected={[]} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(onChange).toHaveBeenCalledWith([{ type: "plan" }]);
    rerender(<ReferenceScopeBrowser state={state} selected={[{ type: "plan" }]} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("locks a record already covered by a selected parent", () => {
    render(<ReferenceScopeBrowser state={state} selected={[{ type: "plan" }]} onChange={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Enter · 2" })[0]!);
    const [areaCheckbox] = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(areaCheckbox!.disabled).toBe(true);
    expect(areaCheckbox!.checked).toBe(true);
    expect(screen.getAllByText("Included by a selected parent").length).toBe(2);
  });

  it("summarises what the download will contain and clears the whole selection", () => {
    const onChange = vi.fn();
    render(<ReferenceScopeBrowser state={state} selected={[{ type: "plan" }]} onChange={onChange} />);
    expect(screen.getByText("1 scope")).toBeTruthy();
    expect(screen.getByText(/2 areas · 2 outcomes · 2 projects/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
