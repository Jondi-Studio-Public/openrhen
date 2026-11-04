// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { QuestionField } from "./question-field";

const question = (field: string, suggestions: string[]) => ({
  field,
  question: field === "importance" ? "How important is this one?" : "Which project?",
  suggestions,
  input: "text" as const
});

describe("QuestionField", () => {
  it("gives a rating's bare number chips their scale, spoken and shown", () => {
    const onChange = vi.fn();
    render(<QuestionField idPrefix="q" question={question("importance", ["2", "3"])} value="" onChange={onChange} />);
    const chip = screen.getByRole("button", { name: "2 of 5" });
    expect(chip.textContent).toBe("2");
    expect(chip.getAttribute("title")).toBe("2 on a scale of 1 to 5");
    expect(screen.getByText("Scale 1 (low) to 5 (high)")).toBeTruthy();
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith("2");
  });

  it("also covers consequence, and a nested field path", () => {
    render(<QuestionField idPrefix="q" question={question("fields.consequence", ["4"])} value="" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "4 of 5" })).toBeTruthy();
  });

  it("leaves other suggestions as they are", () => {
    render(<QuestionField idPrefix="q" question={question("projectId", ["Maths", "7"])} value="" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Maths" }).getAttribute("title")).toBeNull();
    expect(screen.getByRole("button", { name: "7" })).toBeTruthy();
    expect(screen.queryByText(/Scale 1/)).toBeNull();
  });
});
