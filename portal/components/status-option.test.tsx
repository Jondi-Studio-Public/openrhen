// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { statusOption } from "@/components/status-option";

describe("statusOption", () => {
  it("spells a stored status as words while keeping the stored value", () => {
    render(
      <select defaultValue="active" aria-label="Status">
        {["active", "needs_breakdown"].map(statusOption)}
      </select>
    );
    const option = screen.getByRole<HTMLOptionElement>("option", { name: "needs breakdown" });
    expect(option.value).toBe("needs_breakdown");
  });
});
