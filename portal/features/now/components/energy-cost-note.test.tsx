// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { EnergyCostAnswer } from "@openrhen/contracts";
import { render, screen } from "@/test/render";
import { EnergyCostNote } from "./energy-cost-note";

const energyCost: EnergyCostAnswer = {
  declaredEnergy: "low",
  blockedCount: 3,
  dueSoon: [{ actionId: "a", title: "Unit 3", deadlineAt: "2026-11-05T23:00:00.000Z" }],
  text: "Low energy is holding back 3 actions, 1 due Friday.",
  next: "Tell the person the text once."
};

describe("EnergyCostNote", () => {
  it("shows the sentence as given, as plain text with no buttons", () => {
    render(<EnergyCostNote energyCost={energyCost} />);
    expect(screen.getByText("Low energy is holding back 3 actions, 1 due Friday.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/Tell the person/)).toBeNull();
  });

  it("renders nothing when there is no note", () => {
    const { container } = render(<EnergyCostNote energyCost={null} />);
    expect(container.textContent).toBe("");
  });
});
