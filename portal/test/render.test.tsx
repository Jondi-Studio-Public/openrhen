// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@/test/render";

function Probe() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Clicked {count}
    </button>
  );
}

describe("component test harness (@/test/render)", () => {
  it("renders and reacts to a click under jsdom", () => {
    render(<Probe />);
    const button = screen.getByRole("button", { name: "Clicked 0" });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Clicked 1" })).toBe(button);
  });
});
