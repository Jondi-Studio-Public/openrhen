// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { Meter, Stat } from "./stat";

describe("Stat", () => {
  it("shows the value and its label", () => {
    render(<Stat value="4h" label="Free today" />);
    expect(screen.getByText("4h")).toBeTruthy();
    expect(screen.getByText("Free today")).toBeTruthy();
  });
});

describe("Meter", () => {
  it("exposes its value to assistive tech", () => {
    render(<Meter value={0.25} label="Day used" />);
    const meter = screen.getByRole("meter", { name: "Day used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("0.25");
    expect(meter.getAttribute("aria-valuetext")).toBe("25%");
  });

  it("clamps out-of-range values", () => {
    render(
      <>
        <Meter value={3} label="High" />
        <Meter value={-1} label="Low" />
      </>
    );
    expect(screen.getByRole("meter", { name: "High" }).getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByRole("meter", { name: "Low" }).getAttribute("aria-valuenow")).toBe("0");
  });
});
