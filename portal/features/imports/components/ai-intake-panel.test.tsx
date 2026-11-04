// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { AiIntakePanel } from "./ai-intake-panel";

const props = {
  kind: "brain_dump" as const,
  text: "",
  images: [] as File[],
  busy: false,
  onKindChange: vi.fn(),
  onTextChange: vi.fn(),
  onImagesChange: vi.fn(),
  onExtract: vi.fn()
};

describe("AiIntakePanel", () => {
  it("keeps extraction unavailable until there is text or an image", () => {
    const { rerender } = render(<AiIntakePanel {...props} />);
    const extract = () => screen.getByRole("button", { name: "Extract into review draft" }) as HTMLButtonElement;
    expect(extract().disabled).toBe(true);
    rerender(<AiIntakePanel {...props} text="   " />);
    expect(extract().disabled).toBe(true);
    rerender(<AiIntakePanel {...props} text="Some notes" />);
    expect(extract().disabled).toBe(false);
  });

  it("reports the chosen kind and typed text back to the page", () => {
    const onKindChange = vi.fn();
    const onTextChange = vi.fn();
    render(<AiIntakePanel {...props} onKindChange={onKindChange} onTextChange={onTextChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "assignment" } });
    expect(onKindChange).toHaveBeenCalledWith("assignment");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Read chapter 4" } });
    expect(onTextChange).toHaveBeenCalledWith("Read chapter 4");
  });

  it("names the selected images once some are chosen", () => {
    render(<AiIntakePanel {...props} images={[new File(["x"], "brief.png", { type: "image/png" })]} />);
    expect(screen.getByText("Selected: brief.png")).toBeTruthy();
  });

  it("runs the extraction when asked", () => {
    const onExtract = vi.fn();
    render(<AiIntakePanel {...props} text="notes" onExtract={onExtract} />);
    fireEvent.click(screen.getByRole("button", { name: "Extract into review draft" }));
    expect(onExtract).toHaveBeenCalledOnce();
  });
});
