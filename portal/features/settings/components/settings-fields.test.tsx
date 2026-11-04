// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import {
  ContextChoices,
  HourInput,
  MinuteInput,
  PercentInput,
  Section
} from "@/features/settings/components/settings-fields";

describe("Section", () => {
  it("marks a featured section with the class the stylesheet expects", () => {
    const { container } = render(
      <Section featured title="Sleep and time" reason="Your preferred routine.">
        <input />
      </Section>
    );
    expect(container.querySelector("section")?.className).toBe("settings-section settings-section-featured");
    expect(screen.getByRole("heading", { name: "Sleep and time" })).toBeTruthy();
  });

  it("leaves an ordinary section unmodified", () => {
    const { container } = render(
      <Section title="Buffers" reason="Protected time.">
        <input />
      </Section>
    );
    expect(container.querySelector("section")?.className).toBe("settings-section");
    expect(screen.getByText("Protected time.")).toBeTruthy();
  });
});

describe("ContextChoices", () => {
  it("adds and removes a context without disturbing the others", () => {
    const onChange = vi.fn();
    render(<ContextChoices options={["home", "campus"]} selected={["home"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "campus" }));
    expect(onChange).toHaveBeenCalledWith(["home", "campus"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "home" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

describe("numeric inputs", () => {
  it("shows minutes as hours and reports the change back in minutes", () => {
    const onChange = vi.fn();
    render(<HourInput value={480} onChange={onChange} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("8");
    fireEvent.change(input, { target: { value: "7.5" } });
    expect(onChange).toHaveBeenCalledWith(450);
  });

  it("shows a fraction as a percentage and reports the change back as a fraction", () => {
    const onChange = vi.fn();
    render(<PercentInput value={0.85} onChange={onChange} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("85");
    fireEvent.change(input, { target: { value: "75" } });
    expect(onChange).toHaveBeenCalledWith(0.75);
  });

  it("passes minutes straight through", () => {
    const onChange = vi.fn();
    render(<MinuteInput value={10} onChange={onChange} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "25" } });
    expect(onChange).toHaveBeenCalledWith(25);
  });
});
