import { describe, expect, it } from "vitest";
import { handoffPrompt, bringBackPrompt, coordinationPrompts } from "./coordination-prompts";

describe("coordination prompts", () => {
  const deliverable = { title: "Rewrite the user guide", id: "deli-123" };

  it("interpolates the title and id into the handoff prompt", () => {
    const prompt = handoffPrompt(deliverable);
    expect(prompt).toContain("Rewrite the user guide");
    expect(prompt).toContain("deli-123");
    expect(prompt).toContain("rhen deliverable pick-up");
    expect(prompt).toContain("rhen deliverable drop-off");
  });

  it("interpolates the title and id into the bring-back prompt", () => {
    const prompt = bringBackPrompt(deliverable);
    expect(prompt).toContain("Rewrite the user guide");
    expect(prompt).toContain("deli-123");
    expect(prompt).toContain("rhen deliverable drop-off");
  });

  it("returns both prompts from coordinationPrompts", () => {
    const prompts = coordinationPrompts(deliverable);
    expect(prompts.handoff).toBe(handoffPrompt(deliverable));
    expect(prompts.bringBack).toBe(bringBackPrompt(deliverable));
  });
});
