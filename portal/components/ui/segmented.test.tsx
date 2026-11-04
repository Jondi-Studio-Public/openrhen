// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { Segmented } from "./segmented";

const options = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" }
];

describe("Segmented", () => {
  it("is a radio group with the selected option checked", () => {
    render(<Segmented options={options} value="week" onChange={() => {}} label="Range" />);
    expect(screen.getByRole("radiogroup", { name: "Range" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Week" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Day" }).getAttribute("aria-checked")).toBe("false");
  });

  it("keeps only the selected option in the tab order", () => {
    render(<Segmented options={options} value="week" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "Week" }).tabIndex).toBe(0);
    expect(screen.getByRole("radio", { name: "Day" }).tabIndex).toBe(-1);
  });

  it("selects on click", () => {
    const onChange = vi.fn();
    render(<Segmented options={options} value="day" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(onChange).toHaveBeenCalledWith("month");
  });

  it("moves with the arrow keys, wrapping at the ends", () => {
    const onChange = vi.fn();
    render(<Segmented options={options} value="month" onChange={onChange} />);
    const month = screen.getByRole("radio", { name: "Month" });
    month.focus();
    fireEvent.keyDown(month, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("day");
    fireEvent.keyDown(month, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("week");
  });

  it("moves focus to the newly selected option", () => {
    function Harness() {
      return <Controlled />;
    }
    function Controlled() {
      const [value, setValue] = useState("day");
      return <Segmented options={options} value={value} onChange={setValue} />;
    }
    render(<Harness />);
    const day = screen.getByRole("radio", { name: "Day" });
    day.focus();
    fireEvent.keyDown(day, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Week" }));
    expect(screen.getByRole("radio", { name: "Week" }).getAttribute("aria-checked")).toBe("true");
  });
});
